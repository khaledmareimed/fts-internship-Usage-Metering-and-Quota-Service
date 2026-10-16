import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db } from '../../db/client.js';
import { errorResponses } from '../../errors.js';
import {
  createPlanBody,
  listPlansQuery,
  listPlansResponse,
  planIdParams,
  planSchema,
  updatePlanBody,
} from './schemas.js';
import { createPlan, getPlan, listPlans, updatePlan } from './service.js';

/** Company routes: register under a scope guarded by apiKeyAuth. */
export const planRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  const common = { tags: ['plans'], security: [{ apiKey: [] }] };

  app.get(
    '/plans',
    {
      schema: {
        ...common,
        summary: 'Predefined plans and this company’s custom plans',
        querystring: listPlansQuery,
        response: { 200: listPlansResponse, ...errorResponses },
      },
    },
    async (request) => ({ items: await listPlans(db, request.accountId, request.query) }),
  );

  app.get(
    '/plans/:planId',
    {
      schema: {
        ...common,
        summary: 'One plan',
        params: planIdParams,
        response: { 200: planSchema, ...errorResponses },
      },
    },
    async (request) => getPlan(db, request.accountId, request.params.planId),
  );

  app.post(
    '/plans',
    {
      schema: {
        ...common,
        summary: 'Create a custom plan',
        body: createPlanBody,
        response: { 201: planSchema, ...errorResponses },
      },
    },
    async (request, reply) => reply.code(201).send(await createPlan(db, request.accountId, request.body)),
  );

  app.patch(
    '/plans/:planId',
    {
      schema: {
        ...common,
        summary: 'Edit or (de)activate a custom plan',
        params: planIdParams,
        body: updatePlanBody,
        response: { 200: planSchema, ...errorResponses },
      },
    },
    async (request) => updatePlan(db, request.accountId, request.params.planId, request.body),
  );
};
