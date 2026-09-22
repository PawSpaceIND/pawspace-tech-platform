export type RelocationCase=Record<string,unknown>&{id:string;status:string;customer_id:string;documents:Array<Record<string,unknown>>;milestones:Array<Record<string,unknown>>;quote?:Record<string,unknown>|null;payment?:Record<string,unknown>|null;refunds:Array<Record<string,unknown>>;settlement?:Record<string,unknown>|null;reconciliation?:Record<string,unknown>|null;events:Array<Record<string,unknown>>};
export class RelocationRequestError extends Error{fields:Record<string,string>;status:number;constructor(message:string,status:number,fields:Record<string,string>={}){super(message);this.name="RelocationRequestError";this.status=status;this.fields=fields;}}
async function payload<T>(response:Response){const body=await response.json().catch(()=>({})) as {data?:T;error?:string;fields?:Record<string,string>};if(!response.ok||body.data===undefined)throw new RelocationRequestError(body.error||"Relocation request failed",response.status,body.fields&&typeof body.fields==="object"?body.fields:{});return body.data;}
export async function createRelocationCase(input:Record<string,unknown>){return payload<RelocationCase>(await fetch("/api/relocation",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"create",...input}),signal:AbortSignal.timeout(25000)}));}
export type RelocationCaseSummary = Pick<RelocationCase,"id"|"status"|"customer_id"> & Record<string,unknown>;
export async function loadCustomerRelocationCases(customerId:string,signal?:AbortSignal){if(!customerId.trim())throw new Error("Sign in to view your relocation inquiries.");return payload<RelocationCaseSummary[]>(await fetch(`/api/relocation?scope=customer&customerId=${encodeURIComponent(customerId)}`,{cache:"no-store",signal}));}
export async function loadRelocationCase(caseId:string,signal?:AbortSignal){return payload<RelocationCase>(await fetch(`/api/relocation?scope=customer&caseId=${encodeURIComponent(caseId)}`,{cache:"no-store",signal}));}
export async function loadRelocationQueue(){return payload<Array<Record<string,unknown>>>(await fetch("/api/relocation",{cache:"no-store"}));}
export async function updateRelocationCase(input:Record<string,unknown>){return payload<RelocationCase>(await fetch("/api/relocation",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)}));}
/**
 * Reflects a mutated case's new status into the staff queue list without a full reload. The case list
 * is loaded once and never touched again by an action's response, so after a governed transition the
 * aside kept showing the case's status from before the action (CUST-L-D03: 'documents_pending' after
 * the detail pane had already moved to 'quote_sent'). Returns a NEW array; rows that are not the
 * updated case are returned by reference, unchanged.
 */
export function mergeRelocationQueueStatus(queue:Array<Record<string,unknown>>,updated:RelocationCase):Array<Record<string,unknown>>{
  return queue.map(row=>String(row.id)===updated.id?{...row,status:updated.status}:row);
}
