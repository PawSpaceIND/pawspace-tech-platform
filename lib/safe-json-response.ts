/**
 * Reading a booking API's answer without ever showing the customer a JSON parse error.
 *
 * The Boarding and Sitting review screen showed "Unexpected token 'u', "upstream r"... is not valid JSON"
 * and "Unexpected end of JSON input": the reserve and quote clients called response.json() before looking
 * at the status, so a platform timeout page or an empty 502/503/504 body surfaced as a raw SyntaxError.
 * These helpers read the body as text, parse it only if it is JSON, and give the caller a plain sentence
 * to show instead. Browser-safe and dependency-free.
 */
/** The parsed body, or `undefined` when the answer is empty or not JSON (a JSON `null` stays `null`). */
export async function readJsonBody<T=Record<string,unknown>>(response:Response):Promise<T|null|undefined>{
  // A response-like object with only json() (older callers and test doubles) is still read safely.
  if(typeof (response as {text?:unknown}).text!=="function"){try{return await response.json() as T|null;}catch{return undefined;}}
  const text=await response.text().catch(()=>"");
  if(!text.trim())return undefined;
  try{return JSON.parse(text) as T|null;}catch{return undefined;}
}

/**
 * A request that never reached PawSpace. The browser's own words for it - "Failed to fetch" (Chrome), "Load failed"
 * (Safari), "NetworkError when attempting to fetch resource." (Firefox) - are not customer copy.
 */
export function unreachableMessage(action="finish this step"){
  return`We couldn't reach PawSpace to ${action}. Check your connection and try again.`;
}

/** fetch() whose transport failure is that plain sentence. A cancelled request still rejects with its AbortError. */
export async function fetchOrExplain(input:RequestInfo|URL,init:RequestInit|undefined,action:string):Promise<Response>{
  try{return await fetch(input,init);}
  catch(error){
    if(init?.signal?.aborted||(error as {name?:unknown}|null)?.name==="AbortError")throw error;
    throw new Error(unreachableMessage(action));
  }
}

/**
 * What a screen shows for a failure from any client it calls: a JSON parse error or a browser transport error reads
 * as a sentence with a retry, never as "Unexpected token..." or "Failed to fetch". Other errors keep their message.
 */
export function plainErrorMessage(problem:unknown,fallback:string){
  if(problem instanceof SyntaxError)return"PawSpace sent an answer we could not read. Please try again in a moment.";
  if(problem instanceof TypeError)return /fetch|network|load failed/i.test(problem.message)?"We couldn't reach PawSpace. Check your connection and try again.":fallback;
  return problem instanceof Error&&problem.message.trim()?problem.message:fallback;
}

/** The plain retry sentence for an answer that could not be read (a timeout page, an empty body). */
export function unreadableAnswerMessage(status:number,action="finish this step"){
  return status===0||status>=500
    ?`PawSpace is taking longer than usual to ${action}. Please try again in a moment.`
    :`PawSpace could not ${action} just now. Please try again in a moment.`;
}
