export type RelocationCase=Record<string,unknown>&{id:string;status:string;customer_id:string;documents:Array<Record<string,unknown>>;milestones:Array<Record<string,unknown>>;quote?:Record<string,unknown>|null;payment?:Record<string,unknown>|null;refunds:Array<Record<string,unknown>>;settlement?:Record<string,unknown>|null;reconciliation?:Record<string,unknown>|null;events:Array<Record<string,unknown>>};
async function payload<T>(response:Response){const body=await response.json() as {data?:T;error?:string};if(!response.ok||body.data===undefined)throw new Error(body.error||"Relocation request failed");return body.data;}
export async function createRelocationCase(input:Record<string,unknown>){return payload<RelocationCase>(await fetch("/api/relocation",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"create",...input})}));}
export async function loadRelocationCase(caseId:string){return payload<RelocationCase>(await fetch(`/api/relocation?scope=customer&caseId=${encodeURIComponent(caseId)}`,{cache:"no-store"}));}
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
