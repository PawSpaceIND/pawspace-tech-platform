/** Marker carried only by PawSpace's deliberate, caller-safe HTTP error responses. */
export const GOVERNED_HTTP_ERROR_HEADER="x-pawspace-governed-error";
const GOVERNED_HTTP_ERROR_VALUE="1";

function governedHeaders(source?:HeadersInit){
  const headers=new Headers(source);
  headers.set("cache-control","no-store");
  headers.set(GOVERNED_HTTP_ERROR_HEADER,GOVERNED_HTTP_ERROR_VALUE);
  return headers;
}

/** Create a non-cacheable JSON response whose body is explicitly approved for the caller. */
export function governedJsonError(body:Record<string,unknown>,status:number){
  return Response.json(body,{status,headers:governedHeaders()});
}

/** Mark an already-created trusted 4xx response without trusting arbitrary response objects globally. */
export function markGovernedHttpError(response:Response){
  if(response.status<400||response.status>=500)throw new Error("Only caller-safe 4xx responses may be governed");
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers:governedHeaders(response.headers)});
}

/** Arbitrary thrown Responses are untrusted; only factory-marked 4xx responses may pass through. */
export function isGovernedHttpError(response:Response){
  return response.status>=400&&response.status<500&&response.headers.get(GOVERNED_HTTP_ERROR_HEADER)===GOVERNED_HTTP_ERROR_VALUE;
}
