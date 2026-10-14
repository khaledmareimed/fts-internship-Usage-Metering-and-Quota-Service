import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyLoggerOptions,
  LogController,
  type RawServerDefault,
} from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { adminKeyAuth } from './auth/adminKey.js';
import { apiKeyAuth } from './auth/apiKey.js';
import type { LogLevel } from './config.js';
import type { DbHandle } from './db/client.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { accountRoutes, adminAccountRoutes } from './modules/accounts/routes.js';
import { planRoutes } from './modules/plans/routes.js';
import { userRoutes } from './modules/users/routes.js';
import { consumeRoutes } from './modules/consume/routes.js';
import { historyRoutes } from './modules/history/routes.js';

export type App = FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, FastifyBaseLogger, ZodTypeProvider>;

export interface AppOptions {
  dbHandle: DbHandle;
  logLevel: LogLevel;
  adminKey: string;
  /** Tests capture logs here; defaults to stdout. */
  logStream?: FastifyLoggerOptions['stream'];
}

const healthResponse = z.object({
  status: z.enum(['ok', 'error']),
  database: z.enum(['ok', 'down']),
});

export function buildApp({ dbHandle, logLevel, adminKey, logStream }: AppOptions): App {
  const app = Fastify({
    logger: {
      level: logLevel,
      // Defense in depth: the default serializers don't log headers, but keys must never reach logs.
      redact: ['req.headers["x-api-key"]', 'req.headers["x-admin-key"]'],
      ...(logStream && { stream: logStream }),
    },
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
    genReqId: () => randomUUID(),
    // userId (≤128 chars) arrives URL-encoded in paths: up to 12 bytes per char (default limit is 100).
    maxParamLength: 2048,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  app.decorateRequest('accountId', '');
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.register(swagger, {
    openapi: {
      info: { title: 'Usage Metering Service', version: '1.0.0' },
      components: {
        securitySchemes: {
          apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' },
          adminKey: { type: 'apiKey', in: 'header', name: 'x-admin-key' },
        },
      },
    },
    transform: jsonSchemaTransform,
  });
  app.register(swaggerUi, { routePrefix: '/docs' });

  // Routes are plugins so they load after swagger and get documented.
  app.register(async (routes) => {
    routes.withTypeProvider<ZodTypeProvider>().get(
      '/health',
      { schema: { tags: ['health'], response: { 200: healthResponse, 503: healthResponse } } },
      async (request, reply) => {
        try {
          await dbHandle.db.execute(sql`SELECT 1`);
          return { status: 'ok' as const, database: 'ok' as const };
        } catch (err) {
          request.log.error({ err }, 'health check: database unreachable');
          return reply.code(503).send({ status: 'error', database: 'down' });
        }
      },
    );
  });

  const { db } = dbHandle;
  app.register(
    async (v1) => {
      v1.register(async (admin) => {
        admin.addHook('onRequest', adminKeyAuth(adminKey));
        await admin.register(adminAccountRoutes, { db });
      });
      // Every company route goes in this scope: accountId comes only from the API key.
      v1.register(async (company) => {
        company.addHook('onRequest', apiKeyAuth(db));
        await company.register(accountRoutes, { db });
        await company.register(planRoutes, { db });
        await company.register(userRoutes, { db });
        await company.register(consumeRoutes, { db });
        await company.register(historyRoutes, { db });
      });
    },
    { prefix: '/v1' },
  );

  app.addHook('onClose', async () => {
    await dbHandle.pool.end();
  });

  return app;
}
