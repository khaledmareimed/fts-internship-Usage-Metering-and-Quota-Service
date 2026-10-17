// POST /v1/consume, step by step as docs/CONSUME.md.
import type { Db } from '../../db/client.js';
import { isUniqueViolation } from '../../db/errors.js';
import { evaluateRules, evaluateStaticRules, remaining, type StaticRuleInput } from '../../domain/rules.js';
import { AppError } from '../../errors.js';
import {
  consumeDecide,
  findRequest,
  insertRequest,
  loadContext,
  readUsage,
  REQUEST_ID_UNIQUE,
  upsertRejectedCounters,
} from './repo.js';
import {
  type ConsumeBody,
  type ConsumeContext,
  type ConsumeResponse,
  type StoredRequest,
  toConsumeResponse,
} from './schemas.js';

const userNotFound = (userId: string) =>
  new AppError('USER_NOT_FOUND', `User '${userId}' not found in this account`, { userId });

function ruleInput(ctx: ConsumeContext, units: number): StaticRuleInput {
  return { units, userIsActive: ctx.userIsActive, userPlan: ctx.userPlan, accountPlan: ctx.accountPlan };
}

/** Same requestId: same user and units → the original answer, replayed; anything else → 409. */
function replayOrConflict(stored: StoredRequest, userId: string, body: ConsumeBody): ConsumeResponse {
  if (stored.userId === userId && stored.units === body.units) return toConsumeResponse(stored, true);
  throw new AppError('REQUEST_ID_CONFLICT', `Request '${body.requestId}' was already used with different data`, {
    requestId: body.requestId,
  });
}

export async function consume(db: Db, accountId: string, body: ConsumeBody): Promise<ConsumeResponse> {
  // Fast path 1–2, one lock-free read: user + both plans, and any request stored under this id.
  // Unknown user → 404, not recorded. A retry is answered without taking any lock.
  const loaded = await loadContext(db, accountId, body.userId, body.requestId);
  if (!loaded) throw userNotFound(body.userId);
  const { ctx, existing } = loaded;
  if (existing) return replayOrConflict(existing, ctx.userId, body);

  try {
    // Fast path 3: rules that fail regardless of usage skip the long lock.
    return evaluateStaticRules(ruleInput(ctx, body.units)).length > 0
      ? await rejectFast(db, accountId, ctx, body)
      : await decideLocked(db, accountId, ctx, body);
  } catch (err) {
    // Safety net: another request with this id committed first. Never count twice.
    if (!isUniqueViolation(err, REQUEST_ID_UNIQUE)) throw err;
    const stored = await findRequest(db, accountId, body.requestId);
    if (!stored) throw err;
    return replayOrConflict(stored, ctx.userId, body);
  }
}

/**
 * Fast path 4–5: a short transaction that records the rejection.
 * Usage is read without a lock (only to report monthly failures and remaining), inside the same
 * transaction so the month, the counters and created_at share one now().
 * Lock order is the same as consume_decide(): account usage row → user usage row → requests unique key.
 * Inserting the request first would take the unique key first and deadlock (40P01) against a locked-path
 * request with the same requestId. If the insert hits 23505, the counter updates roll back with it.
 */
async function rejectFast(db: Db, accountId: string, ctx: ConsumeContext, body: ConsumeBody): Promise<ConsumeResponse> {
  const stored = await db.transaction(async (tx) => {
    const used = await readUsage(tx, accountId, ctx.userId);
    const decision = evaluateRules({ ...ruleInput(ctx, body.units), ...used });
    await upsertRejectedCounters(tx, accountId, ctx.userId, {
      accountLimit: ctx.accountPlan.monthlyLimit,
      userLimit: ctx.userPlan.monthlyLimit,
    });
    return insertRequest(tx, {
      accountId,
      requestId: body.requestId,
      userId: ctx.userId,
      externalUserId: body.userId,
      units: body.units,
      accepted: false,
      failedRules: decision.failedRules,
      limitsSnapshot: { account: ctx.accountPlan, user: ctx.userPlan },
      accountUsed: used.accountUsed,
      userUsed: used.userUsed,
      accountRemaining: remaining(ctx.accountPlan.monthlyLimit, used.accountUsed),
      userRemaining: remaining(ctx.userPlan.monthlyLimit, used.userUsed),
    });
  });
  return toConsumeResponse(stored, false);
}

/**
 * The locked decision, CONSUME.md steps 1–9, as one statement (consume v2): the consume_decide() SQL
 * function holds the account and user rows only while it runs. Rules: evaluate_rules(), the SQL twin of
 * domain/rules.ts (kept identical by test/integration/rules-parity.test.ts).
 */
async function decideLocked(db: Db, accountId: string, ctx: ConsumeContext, body: ConsumeBody): Promise<ConsumeResponse> {
  const decided = await consumeDecide(db, accountId, body);
  if (!decided) throw userNotFound(body.userId);
  // 5. Already decided under this id (committed while we waited for the lock): replay or 409.
  if (decided.outcome === 'existing') return replayOrConflict(decided.stored, ctx.userId, body);
  return toConsumeResponse(decided.stored, false);
}
