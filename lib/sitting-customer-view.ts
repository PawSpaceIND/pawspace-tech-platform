import type {SittingCarePlan} from './sitting-lifecycle';
export type SittingCustomerView={id:string;status:string;scheduledStart:string;scheduledEnd:string;totalAmount:number|null;carePlan:SittingCarePlan;carePlanStatus:string|null;events:Array<{id:string;type:string;at:number}>};
const fields=['feeding','medication','emergencyContact','vet','homeAccess','specialInstructions'] as const;
export function sittingCustomerView(rows:unknown,bookingId:string):SittingCustomerView{
 if(!Array.isArray(rows))throw new Error('Sitting booking response is incomplete.');
 const matches=rows.filter(row=>row&&typeof row==='object'&&row.id===bookingId);
 if(matches.length!==1)throw new Error(matches.length?'Sitting booking response is ambiguous.':'Sitting booking was not returned.');
 const row=matches[0];if(typeof row.status!=='string'||!row.status.trim()||!Array.isArray(row.events))throw new Error('Sitting booking response is incomplete.');
 const plan:SittingCarePlan={};for(const field of fields)if(typeof row.carePlan?.plan?.[field]==='string')plan[field]=row.carePlan.plan[field];
 const events=row.events.map((event:Record<string,unknown>)=>{if(!event||typeof event.id!=='string'||typeof event.event_type!=='string'||(!Number.isFinite(Number(event.created_at))||Number(event.created_at)<=0))throw new Error('Sitting activity response is incomplete.');return{id:event.id,type:event.event_type,at:Number(event.created_at)};});
 return{id:row.id,status:row.status,scheduledStart:String(row.scheduled_start||''),scheduledEnd:String(row.scheduled_end||''),totalAmount:row.total_amount!=null&&Number.isFinite(Number(row.total_amount))?Number(row.total_amount):null,carePlan:plan,carePlanStatus:typeof row.carePlan?.status==='string'?row.carePlan.status:null,events};
}
async function request(url:string,body?:Record<string,unknown>):Promise<unknown>{
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
 try{const response=await fetch(url,{cache:'no-store',signal:controller.signal,...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});const payload=await response.json();if(!response.ok||payload?.data==null)throw new Error(payload?.error||'Sitting request failed. Please try again.');return payload.data;}
 catch(error){if(controller.signal.aborted)throw new Error('Sitting request timed out. Please retry the same request.');if(error instanceof SyntaxError)throw new Error('Sitting response could not be read. Please try again.');throw error;}finally{clearTimeout(timer);}
}
export async function loadSittingCustomerView(bookingId:string){return sittingCustomerView(await request(`/api/sitting-lifecycle?scope=customer&bookingId=${encodeURIComponent(bookingId)}`),bookingId);}
export async function saveSittingCustomerPlan(bookingId:string,carePlan:SittingCarePlan,idempotencyKey:string){const data=await request('/api/sitting-lifecycle',{action:'submit_care_plan',bookingId,carePlan,idempotencyKey}) as Record<string,unknown>;if(data.bookingId!==bookingId||data.status!=='care_plan_ready')throw new Error('Care-plan save was not confirmed. Please retry.');}
export async function requestCustomerSittingCancellation(bookingId:string,reason:string){const data=await request('/api/sitting-finance',{action:'request_cancel',bookingId,reason,idempotencyKey:`sitting-cancel-request:${bookingId}:${reason.trim().toLowerCase()}`}) as Record<string,unknown>;if(data.bookingId!==bookingId||typeof data.requestId!=='string'||!data.requestId.trim()||data.status!=='policy_review_required')throw new Error('Cancellation request was not confirmed. Please retry.');return data.requestId;}

export async function requestCustomerSittingDateChange(bookingId:string,requestedStart:string,requestedEnd:string,reason:string){
 const start=new Date(requestedStart).getTime(),end=new Date(requestedEnd).getTime();
 if(!Number.isFinite(start)||!Number.isFinite(end)||start<=Date.now()||end<=start)throw new Error('Choose a future start and an end after the start.');
 if(reason.trim().length<3)throw new Error('Please explain the requested date change.');
 const from=new Date(start).toISOString(),to=new Date(end).toISOString();
 const data=await request('/api/sitting-finance',{action:'request_date_change',bookingId,requestedStart:from,requestedEnd:to,reason:reason.trim(),idempotencyKey:`sitting-date-request:${bookingId}:${from}:${to}`}) as Record<string,unknown>;
 if(data.bookingId!==bookingId||typeof data.requestId!=='string'||!data.requestId.trim()||data.status!=='commercial_quote_required'||data.stayWindowUnchanged!==true)throw new Error('Date-change request was not confirmed. Please retry.');
 return data.requestId;
}
