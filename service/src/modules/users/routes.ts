import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Db } from '../../db/client.js';
import { errorResponses } from '../../errors.js';
import {
  createUserBody,
  createUserResponse,
  listUsersQuery,
  listUsersResponse,
  updateUserBody,
  userParams,
  userQuery,
  userResponse,
} from './schemas.js';
import { createUser, getUser, listUsers, updateUser } from './service.js';

/** Company routes: register under a scope guarded by apiKeyAuth. */
export const userRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  const common = { tags: ['users'], security: [{ apiKey: [] }] };

  app.post(
    '/users',
    {
      schema: {
        ...common,
        summary: 'Register a user',
        body: createUserBody,
        response: { 201: createUserResponse, ...errorResponses },
      },
    },
    async (request, reply) => reply.code(201).send(await createUser(db, request.accountId, request.body)),
  );

  app.get(
    '/users',
    {
      schema: {
        ...common,
        summary: 'List users, newest first',
        querystring: listUsersQuery,
        response: { 200: listUsersResponse, ...errorResponses },
      },
    },
    async (request) => listUsers(db, request.accountId, request.query),
  );

  app.get(
    '/users/:userId',
    {
      schema: {
        ...common,
        summary: 'User plan and usage (userId URL-encoded)',
        params: userParams,
        querystring: userQuery,
        response: { 200: userResponse, ...errorResponses },
      },
    },
    async (request) => getUser(db, request.accountId, request.params.userId, request.query.month),
  );

  app.patch(
    '/users/:userId',
    {
      schema: {
        ...common,
        summary: 'Change plan or (de)activate (usage is kept)',
        params: userParams,
        body: updateUserBody,
        response: { 200: userResponse, ...errorResponses },
      },
    },
    async (request) => updateUser(db, request.accountId, request.params.userId, request.body),
  );
};
