import { authorizeApiRequest, auditApiResponse } from "../../../../lib/api-gateway";
import { GET as communicationsGet, POST as communicationsPost } from "../../communications/route";

type GatewayEnv = { DB: D1Database; FOUNDER_EMAIL?: string };

function canonicalRequest(request: Request) {
  const url = new URL(request.url);
  url.pathname = "/api/communications";
  return new Request(url, request);
}

async function delegate(request: Request, handler: (request: Request) => Promise<Response>) {
  const canonical = canonicalRequest(request);
  const { env } = await import("cloudflare:workers");
  const runtime = env as unknown as GatewayEnv;
  const authorization = await authorizeApiRequest(canonical, runtime);
  if (authorization instanceof Response) return authorization;
  const response = await handler(canonical);
  await auditApiResponse(runtime, authorization.actor, authorization.permission, canonical, response);
  return response;
}

export async function GET(request: Request) {
  return delegate(request, communicationsGet);
}

export async function POST(request: Request) {
  return delegate(request, communicationsPost);
}
