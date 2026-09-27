import {phoneMatchKey} from "./customer-phone";

/** Search before contact masking; this never changes the response's disclosure policy. */
export function matchesCustomerSearch(record:{customerId:string;name:string;primaryPhone:string;crmStage?:string;owner?:string},query:string){
 const q=query.trim().toLowerCase();
 if(!q)return true;
 const digits=q.replace(/\D/g,"");
 if(digits.length>=10&&/^[+\d\s().-]+$/.test(q))return phoneMatchKey(record.primaryPhone)===phoneMatchKey(q);
 return `${record.customerId} ${record.name} ${record.crmStage||""} ${record.owner||""}`.toLowerCase().includes(q);
}

/** Exact phone lookup is independent of the recent-500 Customer 360 list window. */
export async function customerIdsForPhone(db:D1Database,query:string){
 const key=phoneMatchKey(query);
 if(!key||!/^[+\d\s().-]+$/.test(query))return null;
 const {samePhoneSql,samePhoneForms}=await import("./customer-phone");
 const forms=samePhoneForms(key);
 const rows=await db.prepare(`SELECT id FROM canonical_customers WHERE merged_into IS NULL AND ${samePhoneSql("primary_phone")}
 UNION SELECT id FROM crm_contacts WHERE stage IS NOT 'Merged' AND ${samePhoneSql("primary_phone")}`).bind(...forms,...forms).all<{id:string}>();
 return rows.results.map(row=>row.id);
}
