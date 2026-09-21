import { boundedFetch } from "./bounded-fetch";
export type QueuedStatus = { id:string;providerId:string;bookingId:string;action:"on_the_way"|"arrived"|"start_service"|"complete";checklist:string[];createdAt:number;error?:string };
const key=(provider:string)=>`pawspace:partner-status:v1:${encodeURIComponent(provider)}`;
export function readStatusQueue(provider:string,storage:Pick<Storage,"getItem">=localStorage):QueuedStatus[] {
  const raw=storage.getItem(key(provider));
  if(!raw)return[];
  const items:unknown=JSON.parse(raw);
  if(!Array.isArray(items)||items.some(item=>!item||item.providerId!==provider||typeof item.id!=="string"||typeof item.bookingId!=="string"||!["on_the_way","arrived","start_service","complete"].includes(item.action)||!Array.isArray(item.checklist)||!Number.isFinite(item.createdAt)))throw new Error("Saved updates could not be read. Contact Operations before continuing.");
  return items as QueuedStatus[];
}
export function saveStatusQueue(provider:string,items:QueuedStatus[],storage:Pick<Storage,"setItem">=localStorage) {
  storage.setItem(key(provider),JSON.stringify(items));
}
export function enqueueStatus(input:Omit<QueuedStatus,"id"|"createdAt">):QueuedStatus {
  const items=readStatusQueue(input.providerId);
  const existing=items.find(item=>item.bookingId===input.bookingId);
  // [LP-D07] An item still awaiting delivery (no error yet) genuinely conflicts with a second update for
  // the same job. An item that already FAILED (e.g. a 409 geofence refusal - "tap Mark arrived again once
  // you are at the address") is a resolved outcome, not an in-flight one: a fresh tap of the primary
  // control replaces it with the new attempt instead of being refused forever by its own stale entry.
  if(existing&&!existing.error)throw new Error("This job already has a pending update. Sync or resolve it before sending another.");
  const item={...input,id:crypto.randomUUID(),createdAt:Date.now()};
  const next=existing?items.map(value=>value.id===existing.id?item:value):[...items,item];
  saveStatusQueue(input.providerId,next); // A failed disk write must prevent optimistic success.
  return item;
}
const targets={on_the_way:"on_the_way",arrived:"arrived",start_service:"in_service",complete:"completed"};
const order=["assigned","on_the_way","arrived","in_service","completed"];
export function statusAlreadyApplied(item:QueuedStatus,status:string) {
  return order.includes(status)&&order.indexOf(status)>=order.indexOf(targets[item.action]);
}
/** Replay only after the authenticated server confirms current assignment. A lost response is reconciled before retry. */
export async function deliverStatus(item:QueuedStatus,send:typeof boundedFetch=boundedFetch):Promise<void> {
  const transport:typeof boundedFetch=async(...args)=>{try{return await send(...args);}catch(error){throw Object.assign(error instanceof Error?error:new Error("Connection lost"),{retry:true});}};
  const current=await transport(`/api/grooming-lifecycle?bookingId=${encodeURIComponent(item.bookingId)}`,{cache:"no-store"});
  const body=await current.json();
  if(!current.ok)throw Object.assign(new Error(body.error||"Unable to verify this job"),{retry:current.status>=500||current.status===429});
  const booking=body.data?.booking;
  if(!booking||String(booking.provider_id)!==item.providerId)throw new Error("Assignment changed. Ask Operations to resolve this pending update.");
  if(statusAlreadyApplied(item,String(booking.status)))return;
  if(Date.now()-item.createdAt>24*60*60_000)throw new Error("This update is over 24 hours old. Ask Operations to reconcile it.");
  const response=await transport("/api/grooming-lifecycle",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({bookingId:item.bookingId,action:item.action,checklist:item.checklist,clientEventId:item.id})});
  if(!response.ok){const failure=await response.json().catch(()=>({}));throw Object.assign(new Error(failure.error||"Update needs review"),{retry:response.status>=500||response.status===429});}
}

/** Web Locks serialize read/modify/write and replay across tabs sharing the same origin. */
export async function withStatusQueueLock<T>(provider:string,kind:"storage"|"delivery",work:()=>T|Promise<T>):Promise<T> {
  if(typeof navigator==="undefined"||!navigator.locks)throw new Error("This browser cannot safely save offline updates. Use an updated browser or partner app and contact Operations.");
  return navigator.locks.request(`${key(provider)}:${kind}`,work);
}
