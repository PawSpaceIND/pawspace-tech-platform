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
 * A business-rule refusal raised by a library module. It stays an Error (callers and tests can match its
 * message) but carries the HTTP status a route should answer with; authError() maps it to a governed
 * JSON refusal instead of a redacted 500. Input problems are 400, missing records 404, state conflicts 409.
 */
export class GovernedRefusal extends Error{
  status:number;
  constructor(message:string,status=409){super(message);this.name="GovernedRefusal";this.status=status;}
}
export function governedRefusal(message:string,status?:number){
  const inferred=/not found/i.test(message)?404:/\b(required|must be|must |cannot satisfy|keys must|window)\b/i.test(message)?400:409;
  return new GovernedRefusal(message,status??inferred);
}
