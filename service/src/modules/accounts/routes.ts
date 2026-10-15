import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { errorResponses } from '../../errors.js';
import type { Db } from '../../db/client.js';
import {
  accountQuery,
  accountResponse,
  changePlanBody,
  createAccountBody,
  createAccountResponse,
} from './schemas.js';
import { changeAccountPlan, createAccount, getAccount } from './service.js';

interface RouteDeps {
  db: Db;
}

/** Admin-only: register under a scope guarded by adminKeyAuth. */
export const adminAccountRoutes: FastifyPluginAsyncZod<RouteDeps> = async (app, { db }) => {
  app.post(
    '/accounts',
    {
      schema: {
        tags: ['admin'],
        summary: 'Create a company (returns its API key once)',
        security: [{ adminKey: [] }],
        body: createAccountBody,
        response: { 201: createAccountResponse, ...errorResponses },
      },
    },
    async (request, reply) => reply.code(201).send(await createAccount(db, request.body)),
  );
};

/** Company routes: register under a scope guarded by apiKeyAuth. */
export const accountRoutes: FastifyPluginAsyncZod<RouteDeps> = async (app, { db }) => {
  app.get(
    '/account',
    {
      schema: {
        tags: ['account'],
        summary: 'Company info, plan and usage',
        security: [{ apiKey: [] }],
        querystring: accountQuery,
        response: { 200: accountResponse, ...errorResponses },
      },
    },
    async (request) => getAccount(db, request.accountId, request.query.month),
  );

  app.patch(
    '/account',
    {
      schema: {
        tags: ['account'],
        summary: 'Switch the company plan (usage is kept)',
        security: [{ apiKey: [] }],
        body: changePlanBody,
        response: { 200: accountResponse, ...errorResponses },
      },
    },
    async (request) => changeAccountPlan(db, request.accountId, request.body.planId),
  );
};
