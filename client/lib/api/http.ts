import 'server-only';
import type { ApiErrorBody } from '../../types/api';

/** An error answer from the metering service (docs/API.md error shape), or the service being unreachable. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function serviceUrl(): string {
  const url = process.env.SERVICE_URL;
  if (!url) throw new Error('SERVICE_URL is not set');
  return url;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: object;
  // Exactly one of the two keys; both stay on this server.
  apiKey?: string;
  adminKey?: string;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body) headers['content-type'] = 'application/json';
  if (options.apiKey) headers['x-api-key'] = options.apiKey;
  if (options.adminKey) headers['x-admin-key'] = options.adminKey;

  let res: Response;
  try {
    res = await fetch(`${serviceUrl()}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'The metering service is not reachable');
  }
  if (res.ok) return (await res.json()) as T;
  const body = (await res.json().catch(() => null)) as ApiErrorBody | null;
  throw new ApiError(res.status, body?.error.code ?? 'UNKNOWN', body?.error.message ?? `HTTP ${res.status}`);
}
