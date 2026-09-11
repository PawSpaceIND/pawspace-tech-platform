import{eraseCustomerPersonalData}from"../../../../lib/dpdp-erasure";

type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();
async function tableExists(db:D1Database,name:string){return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>());}

export function dpdpRetentionCutoff(asOf:number){const date=new Date(asOf);date.setUTCFullYear(date.getUTCFullYear()-3);return date.getTime();}

export async function runDpdpRetentionSweep(db:D1Database,input:{asOf?:number;limit?:number;requestedBy?:string}={}){
 const asOf=input.asOf??Date.now(),cutoff=dpdpRetentionCutoff(asOf),limit=Math.max(1,Math.min(500,input.limit??100)),requestedBy=input.requestedBy||"system:dpdp-retention";
 if(!await tableExists(db,"canonical_customers"))return{status:"not_ready",cutoff,examined:0,erased:0,failed:0,results:[]};
 const activity=new Map<string,number>();
 if(await tableExists(db,"canonical_bookings")){
  const rows=await db.prepare("SELECT customer_id,MAX(updated_at) last_active FROM canonical_bookings GROUP BY customer_id").all<Row>();
  for(const row of rows.results){const id=text(row.customer_id);if(id)activity.set(id,Math.max(activity.get(id)||0,Number(row.last_active||0)));}
 }
 if(await tableExists(db,"crm_contacts")){
  const rows=await db.prepare("SELECT c.id customer_id,c.updated_at last_active FROM crm_contacts c JOIN canonical_customers k ON k.id=c.id").all<Row>();
  for(const row of rows.results){const id=text(row.customer_id);if(id)activity.set(id,Math.max(activity.get(id)||0,Number(row.last_active||0)));}
 }
 if(await tableExists(db,"lead_work_items")){
  const rows=await db.prepare("SELECT customer_id,MAX(updated_at) last_active FROM lead_work_items GROUP BY customer_id").all<Row>();
  for(const row of rows.results){const id=text(row.customer_id);if(id)activity.set(id,Math.max(activity.get(id)||0,Number(row.last_active||0)));}
 }
 const candidates=[...activity.entries()].filter(([,lastActive])=>lastActive>0&&lastActive<cutoff).sort((a,b)=>a[1]-b[1]).slice(0,limit);
 const results:Array<Record<string,unknown>>=[];let erased=0,failed=0;
 for(const[customerId,lastActive]of candidates){try{const result=await eraseCustomerPersonalData(db,{customerId,idempotencyKey:`dpdp-retention:${customerId}:${cutoff}`,requestedBy,reason:"automatic_retention_inactive_over_3_years",now:asOf});results.push({customerId,lastActive,status:"erased",requestId:result.requestId,ledgerPreserved:result.ledgerPreserved});erased++;}catch(error){failed++;results.push({customerId,lastActive,status:"failed",error:error instanceof Error?error.message:String(error)});}}
 return{status:failed?"partial_failure":"completed",cutoff,examined:candidates.length,erased,failed,results};
}

export const DPDP_RETENTION_POLICY={inactiveYears:3,financialLedgerImmutable:true,consentRevoked:true,piiPseudonymized:true}as const;
