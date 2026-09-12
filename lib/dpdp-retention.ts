import{eraseCustomerPersonalData}from"./dpdp-erasure";

type Db=D1Database;
type Row=Record<string,unknown>;
const DEFAULT_BATCH=100;
const MAX_BATCH=500;
const DAY_MS=24*60*60*1000;
const text=(value:unknown)=>String(value??"").trim();

async function tableExists(db:Db,name:string){return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>());}

export async function runDpdpTransientRetentionSweep(db:Db,input:{asOf?:number;retentionDays?:number}={}){
 const asOf=input.asOf??Date.now(),retentionDays=Math.max(1,Math.floor(input.retentionDays??30)),cutoff=asOf-retentionDays*DAY_MS;
 const statements:Array<ReturnType<Db["prepare"]>>=[];
 if(await tableExists(db,"universal_provider_location_events"))statements.push(db.prepare("DELETE FROM universal_provider_location_events WHERE created_at<?").bind(cutoff));
 if(await tableExists(db,"route_eta_snapshots"))statements.push(db.prepare("DELETE FROM route_eta_snapshots WHERE calculated_at<?").bind(cutoff));
 if(await tableExists(db,"app_users")&&await tableExists(db,"atlas_secure_context_facts"))statements.push(db.prepare("DELETE FROM atlas_secure_context_facts WHERE customer_id IN (SELECT id FROM app_users WHERE status='deleted' AND updated_at<?)").bind(cutoff));
 if(await tableExists(db,"app_users")&&await tableExists(db,"atlas_vector_memories"))statements.push(db.prepare("DELETE FROM atlas_vector_memories WHERE customer_id IN (SELECT id FROM app_users WHERE status='deleted' AND updated_at<?)").bind(cutoff));
 if(statements.length)await db.batch(statements);
 return{status:"completed",retentionDays,cutoff,statements:statements.length};
}

export async function runDpdpRetentionSweep(db:Db,input:{asOf?:number;requestedBy?:string;limit?:number}={}){
 const asOf=input.asOf??Date.now(),cutoffDate=new Date(asOf);cutoffDate.setUTCFullYear(cutoffDate.getUTCFullYear()-3);
 const cutoff=cutoffDate.getTime(),requestedBy=text(input.requestedBy)||"system:dpdp-retention",limit=Math.min(MAX_BATCH,Math.max(1,Math.floor(input.limit??DEFAULT_BATCH)));
 const transient=await runDpdpTransientRetentionSweep(db,{asOf,retentionDays:30});
 if(!await tableExists(db,"crm_contacts")||!await tableExists(db,"canonical_customers"))return{status:"not_ready",cutoff,processed:0,erased:0,failed:0,remaining:0,ledgerPreserved:true,transient};
 const hasBookings=await tableExists(db,"canonical_bookings"),hasMessages=await tableExists(db,"communication_messages");
 const bookingJoin=hasBookings?" LEFT JOIN canonical_bookings b ON b.customer_id=c.id":"",messageJoin=hasMessages?" LEFT JOIN communication_messages m ON m.customer_id=c.id":"";
 const bookingMax=hasBookings?"COALESCE(MAX(b.updated_at),0)":"0",messageMax=hasMessages?"COALESCE(MAX(COALESCE(m.updated_at,m.created_at)),0)":"0";
 const sql=`SELECT c.id customer_id,c.updated_at crm_updated_at,${bookingMax} booking_updated_at,${messageMax} communication_updated_at FROM crm_contacts c JOIN canonical_customers cc ON cc.id=c.id${bookingJoin}${messageJoin} WHERE c.updated_at<? GROUP BY c.id,c.updated_at HAVING ${bookingMax}<? AND ${messageMax}<? ORDER BY c.updated_at ASC LIMIT ?`;
 const rows=await db.prepare(sql).bind(cutoff,cutoff,cutoff,limit).all<Row>();
 let erased=0,failed=0;const results:Array<Record<string,unknown>>=[];
 for(const row of rows.results){
  const customerId=text(row.customer_id);if(!customerId)continue;
  try{const result=await eraseCustomerPersonalData(db,{customerId,idempotencyKey:`dpdp-retention:${customerId}:${cutoff}`,requestedBy,reason:"automated_retention_inactive_over_3_years",now:asOf});erased++;results.push({customerIdHash:result.customerIdHash,status:result.status,ledgerPreserved:result.ledgerPreserved,duplicatePrevented:result.duplicatePrevented});}
  catch(error){failed++;results.push({customerIdHash:null,status:"FAILED",error:error instanceof Error?error.message:String(error)});}
 }
 const countSql=`SELECT COUNT(*) remaining FROM (SELECT c.id FROM crm_contacts c JOIN canonical_customers cc ON cc.id=c.id${bookingJoin}${messageJoin} WHERE c.updated_at<? GROUP BY c.id,c.updated_at HAVING ${bookingMax}<? AND ${messageMax}<?)`;
 const remainingRow=await db.prepare(countSql).bind(cutoff,cutoff,cutoff).first<Row>();
 return{status:failed?"partial_failure":"completed",cutoff,retentionYears:3,processed:rows.results.length,erased,failed,remaining:Number(remainingRow?.remaining||0),ledgerPreserved:failed===0,results,transient};
}
