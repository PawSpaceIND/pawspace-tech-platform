// @ts-expect-error Node 22 strip-types requires the explicit .ts extension at runtime.
import{readJsonBody}from"./safe-json-response.ts";
/**
 * Every Pet Taxi customer call - the fare quote, the driver reservation, the booking, the cancellation and
 * the ride manage reads - answers the customer in plain words, whatever came back.
 *
 * On staging a fare quote hung for ~45 s and the platform answered with its own HTML error page; the
 * client called response.json() on it and the customer read "Unexpected token '<'". A proxy cut-off
 * ("upstream request failed") did the same with "Unexpected token 'u'". Here the body is read as text and
 * parsed only if it is JSON; a 5xx, an unreadable page, a network failure or our own time limit becomes a
 * retry sentence, and a governed refusal (4xx) keeps the server's own sentence. The caller's button stays
 * available, so trying again is always the next step.
 */
export class TaxiRequestError extends Error{
 readonly status:number;readonly code:string|undefined;readonly retryAfterSeconds:number|undefined;readonly retryable:boolean;
 constructor(message:string,init:{status:number;code?:string;retryAfterSeconds?:number;retryable:boolean}){super(message);this.name="TaxiRequestError";this.status=init.status;this.code=init.code;this.retryAfterSeconds=init.retryAfterSeconds;this.retryable=init.retryable;}
}
export const taxiStillWorking=(action:string)=>`PawSpace is taking longer than usual to ${action}. Please try again in a moment.`;
export const taxiUnreachable=(action:string)=>`We could not reach PawSpace to ${action}. Check your connection and try again.`;
const taxiCouldNot=(action:string)=>`PawSpace could not ${action} just now. Please try again in a moment.`;
/** A rule code ("NO_SCHEDULE_AVAILABLE", "slot_taken") rather than a sentence meant for a person. */
const ruleCode=(value:string)=>/^[A-Za-z]+(_[A-Za-z0-9]+)+$/.test(value.trim());
/** Text that is a program's error rather than a sentence for a customer: parse errors, D1/SQLite, stack frames. */
const technical=(value:string)=>/Unexpected (token|end)|JSON|D1_ERROR|SQLITE|NetworkError|Failed to fetch|Load failed|is not a function|Cannot read prop|undefined|NaN|\bat \S+:\d+/i.test(value);
type Answer={data?:unknown;error?:unknown;message?:unknown;code?:unknown;retryAfterSeconds?:unknown};
export type TaxiRequestCopy={
 /** What the customer was doing, completing "PawSpace is taking longer than usual to …". */
 action:string;
 /** The sentence for a refusal that carries no readable reason of its own. */
 refused:string;
 /** Plain sentences for rule codes a route answers with (scheduling answers NO_SCHEDULE_AVAILABLE, SLOT_TAKEN). */
 codes?:Record<string,string>;
 timeoutMs?:number;
};
function refusalSentence(body:Answer,copy:TaxiRequestCopy){
 const error=typeof body.error==="string"?body.error.trim():"",message=typeof body.message==="string"?body.message.trim():"",code=typeof body.code==="string"?body.code.trim():"";
 for(const candidate of[error,code])if(candidate&&copy.codes?.[candidate])return copy.codes[candidate];
 if(error&&!ruleCode(error)&&!technical(error))return error;
 if(message&&!technical(message))return message;
 return copy.refused;
}
export async function taxiRequest<T>(url:string,init:RequestInit,copy:TaxiRequestCopy):Promise<T>{
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),copy.timeoutMs??60_000);
 try{
  let response:Response;
  try{response=await fetch(url,{...init,signal:controller.signal});}
  catch{throw new TaxiRequestError(controller.signal.aborted?taxiStillWorking(copy.action):taxiUnreachable(copy.action),{status:0,retryable:true});}
  const body=await readJsonBody<Answer>(response).catch(()=>undefined);
  if(response.ok&&body&&body.data!==undefined&&body.data!==null)return body.data as T;
  const status=response.status,retryAfter=Number(body?.retryAfterSeconds)||Number(response.headers?.get?.("retry-after"))||undefined,code=typeof body?.code==="string"?body.code:typeof body?.error==="string"&&ruleCode(body.error)?body.error:undefined;
  if(!body)throw new TaxiRequestError(controller.signal.aborted||status===0||status>=500?taxiStillWorking(copy.action):taxiCouldNot(copy.action),{status,retryAfterSeconds:retryAfter,retryable:true});
  if(status>=500||status===429){
   // A governed 5xx names itself with a code and a sentence written for the customer (the fare deadline,
   // the booking retry). Anything else - "Unable to update Pet Taxi finance", a raw D1 message - is a retry.
   const governed=typeof body.code==="string"&&typeof body.error==="string"&&!technical(body.error)&&!ruleCode(body.error);
   throw new TaxiRequestError(governed?String(body.error):taxiStillWorking(copy.action),{status,code,retryAfterSeconds:retryAfter,retryable:true});
  }
  throw new TaxiRequestError(refusalSentence(body,copy),{status,code,retryable:false});
 }finally{clearTimeout(timer);}
}
/** A plain sentence for anything a Taxi screen caught, including errors thrown outside taxiRequest. */
export function taxiErrorMessage(error:unknown,action:string){
 if(error instanceof TaxiRequestError)return error.message;
 const name=error instanceof Error||(typeof error==="object"&&error!==null)?String((error as{name?:unknown}).name||""):"";
 if(name==="AbortError"||name==="TimeoutError")return taxiStillWorking(action);
 if(error instanceof SyntaxError)return taxiStillWorking(action);
 const message=error instanceof Error?error.message.trim():"";
 if(error instanceof TypeError&&/fetch|network|load failed/i.test(message))return taxiUnreachable(action);
 if(message&&!technical(message)&&!ruleCode(message))return message;
 return taxiCouldNot(action);
}
