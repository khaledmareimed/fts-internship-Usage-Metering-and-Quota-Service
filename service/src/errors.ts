import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { z } from 'zod';

// Every error code the API can return (docs/API.md), with its HTTP status.
export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  PLAN_TYPE_MISMATCH: 400,
  MISSING_API_KEY: 401,
  INVALID_API_KEY: 401,
  MISSING_ADMIN_KEY: 401,
  INVALID_ADMIN_KEY: 401,
  PREDEFINED_PLAN_READ_ONLY: 403,
  ACCOUNT_INACTIVE: 403,
  NOT_FOUND: 404,
  USER_NOT_FOUND: 404,
  PLAN_NOT_FOUND: 404,
  REQUEST_NOT_FOUND: 404,
  REQUEST_ID_CONFLICT: 409,
  USER_ALREADY_EXISTS: 409,
  PLAN_NAME_TAKEN: 409,
  PLAN_IN_USE: 409,
  PLAN_INACTIVE: 409,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;
export type ErrorDetails = Record<string, unknown>;

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details: ErrorDetails };
}

const errorBodySchema = z.object({
  error: z.object({
    code: z.enum(Object.keys(ERROR_STATUS) as [ErrorCode, ...ErrorCode[]]),
    message: z.string(),
    details: z.record(z.string(), z.unknown()),
  }),
});

/** Spread into a route's `response` so Swagger documents the error shape. */
export const errorResponses = { '4xx': errorBodySchema, '5xx': errorBodySchema } as const;

/** An expected failure; the status always comes from ERROR_STATUS. */
export class AppError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: ErrorDetails = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = ERROR_STATUS[code];
  }
}

function sendError(reply: FastifyReply, status: number, body: ErrorBody['error']): FastifyReply {
  return reply.code(status).send({ error: body } satisfies ErrorBody);
}

export function errorHandler(err: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  if (err instanceof AppError) {
    return sendError(reply, err.statusCode, { code: err.code, message: err.message, details: err.details });
  }
  if (hasZodFastifySchemaValidationErrors(err)) {
    const issues = err.validation.map((v) => ({
      path: [err.validationContext, ...v.instancePath.split('/').filter(Boolean)].join('.'),
      message: v.message ?? 'Invalid value',
    }));
    return sendError(reply, 400, { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: { issues } });
  }
  // Fastify's own client errors (malformed JSON, body too large, wrong content type).
  if (err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500) {
    return sendError(reply, err.statusCode, { code: 'VALIDATION_ERROR', message: err.message, details: {} });
  }
  request.log.error({ err }, 'unhandled error');
  return sendError(reply, 500, { code: 'INTERNAL_ERROR', message: 'Internal server error', details: {} });
}

export function notFoundHandler(request: FastifyRequest, reply: FastifyReply) {
  return sendError(reply, 404, {
    code: 'NOT_FOUND',
    message: `Route ${request.method} ${request.url} not found`,
    details: {},
  });
}
