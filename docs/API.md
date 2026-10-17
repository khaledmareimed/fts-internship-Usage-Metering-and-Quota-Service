# API Contract — Usage Metering Service

## Conventions

- All endpoints are under `/v1` (e.g. `POST /v1/consume`), except `/health`.
- JSON everywhere, field names in `camelCase`.
- Units are positive integers. Months are `"YYYY-MM"` (UTC).
- `userId` is the company's own user ID (unique per company).
- Auth headers:
  - `x-admin-key: <ADMIN_KEY>` — only for `POST /accounts`
  - `x-api-key: <API_KEY>` — every other endpoint (except `/health`)

### Error shape (all errors)

```json
{
  "error": {
    "code": "USER_NOT_FOUND",
    "message": "User 'ali-123' not found in this account",
    "details": {}
  }
}
```

| Status | Code examples |
|---|---|
| 400 | `VALIDATION_ERROR`, `PLAN_TYPE_MISMATCH` |
| 401 | `MISSING_API_KEY`, `INVALID_API_KEY`, `MISSING_ADMIN_KEY`, `INVALID_ADMIN_KEY` |
| 403 | `PREDEFINED_PLAN_READ_ONLY`, `ACCOUNT_INACTIVE` |
| 404 | `USER_NOT_FOUND`, `PLAN_NOT_FOUND`, `REQUEST_NOT_FOUND` |
| 409 | `REQUEST_ID_CONFLICT`, `USER_ALREADY_EXISTS`, `PLAN_NAME_TAKEN`, `PLAN_IN_USE`, `PLAN_INACTIVE` |

### Shared objects

**Plan**
```json
{
  "planId": "uuid",
  "name": "Basic",
  "type": "user",
  "monthlyLimit": 1000,
  "perRequestLimit": 20,
  "rateLimitPerMinute": null,
  "predefined": true,
  "isActive": true,
  "createdAt": "2026-10-14T08:00:00Z",
  "updatedAt": "2026-10-14T08:00:00Z"
}
```

**Usage**
```json
{
  "month": "2026-10",
  "used": 800,
  "remaining": 200,
  "acceptedCount": 40,
  "rejectedCount": 3
}
```
`remaining = max(0, monthlyLimit - used)`. For the current month, `monthlyLimit` is the plan's live limit. For past months, it is the limit saved on that month's usage row at its last update (one row read, no history scan).
A month with no usage row (nothing consumed yet) reports `used: 0`, zero counts and the plan's live limit. `month` must be `YYYY-MM` and not in the future (by the database clock), otherwise `400 VALIDATION_ERROR`.

---

## Admin

### `POST /accounts` — create a company

Headers: `x-admin-key`

Request
```json
{ "name": "Acme Docs", "planId": "uuid-of-Starter" }
```
Rules: `name` 1–100 chars; `planId` must be an active **account**-type predefined plan.

Response `201`
```json
{
  "accountId": "uuid",
  "name": "Acme Docs",
  "apiKey": "mk_8f3a...",
  "plan": { "...Plan" },
  "createdAt": "2026-10-14T08:00:00Z"
}
```
`apiKey` is shown **only here**. Only its SHA-256 hash is stored (keys are 32 random bytes, so a fast hash is safe; bcrypt would add ~100ms to every request).

Errors: `400`, `400 PLAN_TYPE_MISMATCH`, `401 MISSING_ADMIN_KEY` / `INVALID_ADMIN_KEY`, `404 PLAN_NOT_FOUND`, `409 PLAN_INACTIVE`

---

## Account

### `GET /account` — company info, plan and usage

Query: `month` (optional, default current month)

Response `200`
```json
{
  "accountId": "uuid",
  "name": "Acme Docs",
  "isActive": true,
  "plan": { "...Plan" },
  "usage": { "...Usage" }
}
```

### `PATCH /account` — switch the company plan

Request
```json
{ "planId": "uuid-of-Pro" }
```
Rules: account-type plan, predefined or owned by this company, active. Usage is kept (no fresh allowance).

Response `200`: same as `GET /account`

Errors: `400 PLAN_TYPE_MISMATCH`, `404 PLAN_NOT_FOUND`, `409 PLAN_INACTIVE`

---

## Plans

Predefined plans have fixed ids, so a company can be created without a lookup:

| Plan | Type | Monthly | Per request | `planId` |
|---|---|---|---|---|
| Starter | account | 10,000 | 100 | `00000000-0000-4000-8000-000000000001` |
| Pro | account | 100,000 | 1,000 | `00000000-0000-4000-8000-000000000002` |
| Basic | user | 1,000 | 20 | `00000000-0000-4000-8000-000000000003` |
| Premium | user | 10,000 | 200 | `00000000-0000-4000-8000-000000000004` |

### `GET /plans` — predefined + this company's custom plans

Query: `type` (optional: `account` | `user`), `includeInactive` (optional, default `false`)

Response `200`
```json
{ "items": [ { "...Plan" } ] }
```

### `GET /plans/:planId`

Response `200`: Plan. Errors: `404`

### `POST /plans` — create a custom plan

Request
```json
{
  "name": "Power User",
  "type": "user",
  "monthlyLimit": 5000,
  "perRequestLimit": 50,
  "rateLimitPerMinute": 60
}
```
Rules: name unique within the company; limits are positive integers. `rateLimitPerMinute` is optional
(default `null` = no rate limit): at most that many **accepted** requests per UTC minute (see Consume).

Response `201`: Plan (`predefined: false`)

Errors: `400`, `409 PLAN_NAME_TAKEN`

### `PATCH /plans/:planId` — edit a custom plan

Request (all fields optional, at least one)
```json
{
  "name": "Power User v2",
  "monthlyLimit": 3000,
  "perRequestLimit": 40,
  "rateLimitPerMinute": null,
  "isActive": false
}
```
Rules: custom plans only; `type` cannot change. Deactivating fails if the plan is still assigned (checked with the plan row locked, so no one can assign it at the same moment). Changes apply to new requests immediately.

Response `200`: Plan

Errors: `400`, `403 PREDEFINED_PLAN_READ_ONLY`, `404`, `409 PLAN_IN_USE`

---

## Users

### `POST /users` — register a user

Request
```json
{ "userId": "ali-123", "planId": "uuid-of-Basic" }
```
Rules: `userId` 1–128 chars, unique in this company; user-type plan, active.

Response `201`
```json
{
  "userId": "ali-123",
  "isActive": true,
  "plan": { "...Plan" },
  "createdAt": "2026-10-14T08:00:00Z"
}
```

Errors: `400`, `404 PLAN_NOT_FOUND`, `409 USER_ALREADY_EXISTS`

### `GET /users` — list users

Query: `limit` (1–100, default 20), `cursor` (from previous page)

Response `200`
```json
{
  "items": [
    { "userId": "ali-123", "isActive": true, "planId": "uuid", "planName": "Basic" }
  ],
  "nextCursor": "eyJpZCI6..."
}
```
`nextCursor` is `null` on the last page.

### `GET /users/:userId` — user plan and usage

Query: `month` (optional)

Response `200`
```json
{
  "userId": "ali-123",
  "isActive": true,
  "plan": { "...Plan" },
  "usage": { "...Usage" }
}
```

Errors: `404`

### `PATCH /users/:userId` — change plan or (de)activate

Request (at least one field)
```json
{ "planId": "uuid-of-Premium", "isActive": true }
```
Rules: same plan rules as `POST /users`. Usage is kept.

Response `200`: same as `GET /users/:userId`

Errors: `400`, `404`, `409 PLAN_INACTIVE`

---

## Consume

### `POST /consume` — ask to use units

Request
```json
{ "requestId": "doc-7781", "userId": "ali-123", "units": 10 }
```
Rules: `requestId` 1–128 chars, unique per company; `units` integer ≥ 1.

Response `200` — accepted
```json
{
  "requestId": "doc-7781",
  "accepted": true,
  "units": 10,
  "failedRules": [],
  "month": "2026-10",
  "account": { "used": 4010, "remaining": 5990, "monthlyLimit": 10000, "perRequestLimit": 100 },
  "user":    { "userId": "ali-123", "used": 810, "remaining": 190, "monthlyLimit": 1000, "perRequestLimit": 20 },
  "replayed": false,
  "decidedAt": "2026-10-14T08:15:00Z"
}
```

Response `200` — rejected (nothing consumed)
```json
{
  "requestId": "doc-7782",
  "accepted": false,
  "units": 25,
  "failedRules": [
    { "scope": "user", "rule": "per_request_limit", "limit": 20, "requested": 25 },
    { "scope": "account", "rule": "monthly_limit", "limit": 10000, "remaining": 5 }
  ],
  "month": "2026-10",
  "account": { "...": "unchanged totals" },
  "user":    { "...": "unchanged totals" },
  "replayed": false,
  "decidedAt": "2026-10-14T08:16:00Z"
}
```

Rule names: `per_request_limit`, `monthly_limit`, `inactive` (scope `user`), `rate_limit`. All failing rules are listed, in this order:
user `inactive`, user / account `per_request_limit`, user / account `monthly_limit`, user / account `rate_limit`.

**Rate limit** (optional, from the plan's `rateLimitPerMinute`): at most N **accepted** requests per scope in a
fixed UTC minute (database clock). Rejections and replays don't count. Failure:
`{ "scope": "user", "rule": "rate_limit", "limit": 5, "remaining": 0 }` (`remaining` = left in this minute).
A fixed window can allow up to 2×N across a minute boundary.

**Retries**
- Same `requestId` + same `userId` and `units` → `200` with the **original** answer and `"replayed": true`. Nothing is counted again.
- Same `requestId` + different data → `409 REQUEST_ID_CONFLICT`.

Errors: `400`, `401`, `404 USER_NOT_FOUND`, `409 REQUEST_ID_CONFLICT`

---

## History

### `GET /requests` — past decisions, newest first

Query: `userId`, `month`, `limit` (1–100, default 20), `cursor` — all optional (each filter is backed by an index)

Response `200`
```json
{
  "items": [
    {
      "requestId": "doc-7782",
      "userId": "ali-123",
      "units": 25,
      "accepted": false,
      "failedRules": [ { "scope": "user", "rule": "per_request_limit", "limit": 20, "requested": 25 } ],
      "limits": {
        "account": { "planName": "Starter", "monthlyLimit": 10000, "perRequestLimit": 100, "rateLimitPerMinute": null },
        "user":    { "planName": "Basic",   "monthlyLimit": 1000,  "perRequestLimit": 20,  "rateLimitPerMinute": null }
      },
      "accountRemaining": 5990,
      "userRemaining": 190,
      "createdAt": "2026-10-14T08:16:00Z"
    }
  ],
  "nextCursor": null
}
```

### `GET /requests/:requestId` — one decision

Response `200`: one history item. Errors: `404 REQUEST_NOT_FOUND`

---

## Health

### `GET /health` — no auth

Response `200`
```json
{ "status": "ok", "database": "ok" }
```
