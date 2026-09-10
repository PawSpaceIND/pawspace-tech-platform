import type {BoardingStay} from './boarding-stay-client';
import type {BoardingCarePlan} from './boarding-stay-lifecycle';
async function request(url:string,input?:Record<string,unknown>):Promise<unknown>{
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
 try{const response=await fetch(url,{cache:'no-store',signal:controller.signal,...(input?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}:{})});const payload=await response.json();if(!response.ok||payload?.data==null)throw new Error(payload?.error||'Boarding request was not confirmed.');return payload.data;}
 catch(problem){if(controller.signal.aborted)throw new Error('Boarding request timed out. Please retry.');if(problem instanceof SyntaxError)throw new Error('Boarding response could not be read. Please retry.');throw problem;}finally{clearTimeout(timer);}
}
export async function loadOwnedBoardingStay(bookingId:string):Promise<BoardingStay|null>{
 const data=await request(`/api/boarding-stays?scope=customer&bookingId=${encodeURIComponent(bookingId)}`);
 if(!Array.isArray(data))throw new Error('Boarding stay response is incomplete.');if(!data.length)return null;
 if(data.length!==1||data[0]?.booking_id!==bookingId||typeof data[0]?.id!=='string'||!data[0].id.trim()||typeof data[0]?.status!=='string')throw new Error('Boarding stay response is ambiguous or belongs to another booking.');return data[0] as BoardingStay;
}
export async function saveCustomerBoardingCare(bookingId:string,carePlan:BoardingCarePlan,idempotencyKey:string){
 if(!carePlan.vet?.trim()||!carePlan.emergencyContact?.trim())throw new Error('Add vet and emergency contact details before saving the care plan.');
 const stay=await loadOwnedBoardingStay(bookingId);if(!stay)throw new Error('Boarding stay was not found. Your care instructions have not been saved.');
 const data=await request('/api/boarding-stays',{stayId:stay.id,action:'submit_care_plan',carePlan,idempotencyKey}) as Record<string,unknown>;
 if(data.stayId!==stay.id||data.bookingId!==bookingId||data.status!=='care_plan_ready')throw new Error('Boarding care-plan save was not confirmed. Please retry.');
}
export function boardingCareDraft(input:BoardingCarePlan,requests:string[],benefits:string[],food:string):BoardingCarePlan{
 return {feeding:input.feeding||'',medication:input.medication||'',vet:input.vet||'',emergencyContact:input.emergencyContact||'',specialInstructions:[input.specialInstructions,requests.length?`Care requests: ${requests.join(', ')}`:'',benefits.length?`Requested extras (subject to host agreement): ${benefits.join(', ')}`:'',food?`Food preference: ${food}`:''].filter(Boolean).join('\n')};
}
