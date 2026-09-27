import {phoneMatchKey} from "./customer-phone";

/** Search before contact masking; this never changes the response's disclosure policy. */
export function matchesCustomerSearch(record:{customerId:string;name:string;primaryPhone:string;crmStage?:string;owner?:string},query:string){
 const q=query.trim().toLowerCase();
 if(!q)return true;
 const digits=q.replace(/\D/g,"");
 if(digits.length>=10&&/^[+\d\s().-]+$/.test(q))return phoneMatchKey(record.primaryPhone)===phoneMatchKey(q);
 return `${record.customerId} ${record.name} ${record.crmStage||""} ${record.owner||""}`.toLowerCase().includes(q);
}
