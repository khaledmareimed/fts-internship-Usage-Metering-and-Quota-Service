import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db } from '../../db/client.js';
import { errorResponses } from '../../errors.js';
import { historyItemSchema, historyListResponse, historyQuery, requestParams } from './schemas.js';
import { getHistoryItem, listHistory } from './service.js';

/** Company routes: register under a scope guarded by apiKeyAuth. */
export const historyRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  const common = { tags: ['history'], security: [{ apiKey: [] }] };

  app.get(
    '/requests',
    {
      schema: {
        ...common,
        summary: 'Past decisions, newest first (filters: userId, month)',
        querystring: historyQuery,
        response: { 200: historyListResponse, ...errorResponses },
      },
    },
    async (request) => listHistory(db, request.accountId, request.query),
  );

  app.get(
    '/requests/:requestId',
    {
      schema: {
        ...common,
        summary: 'One decision (requestId URL-encoded)',
        params: requestParams,
        response: { 200: historyItemSchema, ...errorResponses },
      },
    },
    async (request) => getHistoryItem(db, request.accountId, request.params.requestId),
  );
};
