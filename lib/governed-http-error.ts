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
