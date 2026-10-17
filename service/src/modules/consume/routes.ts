import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db } from '../../db/client.js';
import { errorResponses } from '../../errors.js';
import { consumeBody, consumeResponse } from './schemas.js';
import { consume } from './service.js';

/** Company routes: register under a scope guarded by apiKeyAuth. */
export const consumeRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.post(
    '/consume',
    {
      schema: {
        tags: ['consume'],
        summary: 'Ask to use units (accepted and rejected both return 200)',
        security: [{ apiKey: [] }],
        body: consumeBody,
        response: { 200: consumeResponse, ...errorResponses },
      },
    },
    async (request) => consume(db, request.accountId, request.body),
  );
};
