import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from './src/app.js';
import { createRepository } from './src/repository.js';

const app = buildApp(await createRepository());
await app.ready();

const APPLICATION_ORIGIN = String(process.env.PAWSPACE_APPLICATION_ORIGIN || 'https://app.pawspace.in').replace(/\/$/, '');
const MAX_PROXY_BODY_BYTES = 1024 * 1024;
const APPLICATION_ROUTE_PREFIXES = [
  '/api/whatsapp/meta-webhook',
  '/api/elite-runtime',
  '/api/elite-surge-preview',
] as const;

function targetsApplicationRuntime(pathname: string) {
  return APPLICATION_ROUTE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

async function readBody(request: IncomingMessage): Promise<Uint8Array | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_PROXY_BODY_BYTES) throw Object.assign(new Error('Proxy request body exceeded the application routing limit'), { statusCode: 413 });
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function upstreamHeaders(request: IncomingMessage) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value == null || ['host', 'content-length', 'connection'].includes(name.toLowerCase())) continue;
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else headers.set(name, value);
  }
  headers.set('x-pawspace-router', 'vercel-fastify-to-cloudflare');
  return headers;
}

async function proxyApplicationRoute(request: IncomingMessage, response: ServerResponse) {
  const path = request.url || '/';
  const target = new URL(path, `${APPLICATION_ORIGIN}/`);
  try {
    const body = await readBody(request);
    const upstream = await fetch(target, {
      method: request.method,
      headers: upstreamHeaders(request),
      body,
      redirect: 'manual',
    });
    response.statusCode = upstream.status;
    upstream.headers.forEach((value, name) => {
      if (!['content-length', 'transfer-encoding', 'connection'].includes(name.toLowerCase())) response.setHeader(name, value);
    });
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-pawspace-upstream-runtime', 'cloudflare-vinext');
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    const status = Number((error as { statusCode?: number })?.statusCode || 502);
    response.statusCode = status;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.end(JSON.stringify({
      error: {
        code: status === 413 ? 'APPLICATION_PROXY_BODY_TOO_LARGE' : 'APPLICATION_ORIGIN_UNAVAILABLE',
        message: status === 413
          ? 'Request body exceeded the application routing limit'
          : 'The PawSpace application runtime could not be reached',
      },
    }));
  }
}

export default function handler(request: IncomingMessage, response: ServerResponse) {
  const pathname = new URL(request.url || '/', 'https://vercel.pawspace.invalid').pathname;
  if (targetsApplicationRuntime(pathname)) {
    void proxyApplicationRoute(request, response);
    return;
  }
  app.server.emit('request', request, response);
}
