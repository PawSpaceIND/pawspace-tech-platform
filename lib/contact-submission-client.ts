type ContactStorage=Pick<Storage,"getItem"|"setItem">;
type ContactOptions={storage?:ContactStorage;fetcher?:typeof fetch;cryptoApi?:Crypto;timeoutMs?:number};
export const CONTACT_SUBMISSION_STORAGE_KEY="pawspace.contact-submission.v1";
export const CONTACT_SUBMISSION_TIMEOUT_MS=15_000;
const validId=(value:unknown)=>typeof value==="string"&&/^[-A-Za-z0-9_]{16,128}$/.test(value);
/** Persist only an opaque request ID and digest, never contact details or message text. */
export async function prepareContactSubmission(body:Record<string,unknown>,storage:ContactStorage,cryptoApi:Crypto=crypto){
 const serialized=JSON.stringify(body);
 const digest=await cryptoApi.subtle.digest("SHA-256",new TextEncoder().encode(serialized));
 const fingerprint=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,"0")).join("");
 let previous:{fingerprint?:unknown;requestId?:unknown;version?:unknown}|null=null;
 try{const raw=storage.getItem(CONTACT_SUBMISSION_STORAGE_KEY);if(raw)previous=JSON.parse(raw);}
 catch{throw new Error("Safe enquiry recovery is unavailable in this browser. Enable browser storage before sending.");}
 if(previous?.version===1&&previous.fingerprint===fingerprint&&validId(previous.requestId))return String(previous.requestId);
 const requestId=cryptoApi.randomUUID();
 const next=JSON.stringify({version:1,fingerprint,requestId});
 try{storage.setItem(CONTACT_SUBMISSION_STORAGE_KEY,next);if(storage.getItem(CONTACT_SUBMISSION_STORAGE_KEY)!==next)throw new Error("write_not_retained");}
 catch{throw new Error("Safe enquiry recovery could not be saved. Enable browser storage before sending.");}
 return requestId;
}
export async function submitContactEnquiry(body:Record<string,unknown>,options:ContactOptions={}){
 let storage:ContactStorage;
 try{storage=options.storage??window.sessionStorage;}catch{throw new Error("Enable browser storage before sending this enquiry.");}
 const requestId=await prepareContactSubmission(body,storage,options.cryptoApi??crypto);
 const fetcher=options.fetcher??fetch,controller=new AbortController();
 const requested=options.timeoutMs??CONTACT_SUBMISSION_TIMEOUT_MS;
 if(!Number.isFinite(requested)||requested<1||requested>30_000)throw new Error("Invalid enquiry request deadline");
 const timer=setTimeout(()=>controller.abort(),requested);
 try{
  const response=await fetcher("/api/public-contact",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...body,requestId}),signal:controller.signal});
  const result=await response.json() as {ok?:boolean;leadId?:string;error?:string;duplicatePrevented?:boolean};
  if(!response.ok)throw new Error(result.error||"Your enquiry could not be confirmed. Retry with the same details.");
  if(result.ok!==true||typeof result.leadId!=="string"||!result.leadId)throw new Error("The enquiry response was incomplete. Retry with the same details.");
  return result;
 }catch(error){
  if(controller.signal.aborted)throw new Error("The response timed out. Your enquiry may already be saved; retry with the same details to recover it safely.");
  if(error instanceof Error&&error.name!=="TypeError"&&error.name!=="SyntaxError")throw error;
  throw new Error("We could not confirm the response. Retry with the same details; the same enquiry reference will be reused.");
 }finally{clearTimeout(timer);}
}
