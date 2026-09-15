/** Caller-safe HTTP errors are trusted by in-process object identity, never by client-visible metadata. */
const governedHttpErrors=new WeakSet<Response>();

function noStoreHeaders(source?:HeadersInit){
  const headers=new Headers(source);
  headers.set("cache-control","no-store");
  return headers;
}

/** Create a non-cacheable JSON response whose body is explicitly approved for the caller. */
export function governedJsonError(body:Record<string,unknown>,status:number){
  const response=Response.json(body,{status,headers:noStoreHeaders()});
  governedHttpErrors.add(response);
  return response;
}

/** Mark an already-created trusted 4xx response without trusting arbitrary response headers or bodies. */
export function markGovernedHttpError(response:Response){
  if(response.status<400||response.status>=500)throw new Error("Only caller-safe 4xx responses may be governed");
  const governed=new Response(response.body,{status:response.status,statusText:response.statusText,headers:noStoreHeaders(response.headers)});
  governedHttpErrors.add(governed);
  return governed;
}

/** Arbitrary thrown Responses are untrusted; only factory-marked response objects may pass through. */
export function isGovernedHttpError(response:Response){
  return response.status>=400&&response.status<500&&governedHttpErrors.has(response);
}

/**
 * Cross-boundary client errors. [PTJA-AUTHERR-422]
 *
 * backend/src/* is a standalone Fastify app: it uses NodeNext ".js" specifiers, imports nothing from
 * lib/, and signals client faults the Fastify way - a plain Error carrying `statusCode`, which
 * backend/src/app.ts's setErrorHandler turns into the right status. The SAME functions are also called
 * from app/api/* routes inside the Worker, where the catch lands in authError(), which trusts Response
 * objects only - so every one of those refusals was being reported to the caller as a 500.
 *
 * The brand is a *registry* symbol rather than an import so neither side has to reach across that
 * boundary: Symbol.for() returns the identical symbol in both modules, and an error object can only
 * carry it if someone deliberately put it there. That keeps the opt-in explicit, exactly like the
 * WeakSet above - an incidental `statusCode` from a fetch/undici/Fastify internal error is NOT
 * enough to get a message in front of a caller, so upstream URLs and tokens still cannot leak.
 */
export const GOVERNED_CLIENT_ERROR=Symbol.for("pawspace.governed-client-error");

/** Bridge a branded Fastify-convention client error into a governed 4xx, or null if it is not one. */
export function governedClientErrorResponse(error:unknown){
  if(!error||typeof error!=="object"||!(GOVERNED_CLIENT_ERROR in error))return null;
  if((error as Record<PropertyKey,unknown>)[GOVERNED_CLIENT_ERROR]!==true)return null;
  const status=Number((error as {statusCode?:unknown}).statusCode);
  if(!Number.isInteger(status)||status<400||status>=500)return null;
  const message=error instanceof Error?error.message:"";
  if(!message)return null;
  return governedJsonError({error:message},status);
}
