import{eraseCustomerPersonalData}from"./dpdp-erasure";

type Db=D1Database;
type Row=Record<string,unknown>;
const DEFAULT_BATCH=100;
const MAX_BATCH=500;
const text=(value:unknown)=>String(value??"").trim();

async function tableExists(db:Db,name:string){return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type=\'table\' AND name=?").bind(name).first<Row>());}

export async function runDpdpRetentionSweep(db:Db,input:{asOf?:number;requestedBy?:string;limit?:number}={}){
 const asOf=input.asOf??Date.now(),cutoffDate=new Date(asOf);cutoffDate.setUTCFullYear(cutoffDate.getUTCFullYear()-3);const cutoff=cutoffDate.getTime(),requestedBy=text(input.requestedBy)||"system:dpdp-retention",limit=Math.min(MAX_BATCH,Math.max(1,Math.floor(input.limit??DEFAULT_BATCH)));
 if(!await tableExists(db,"crm_contacts")||!await tableExists(db,"canonical_customers"))return{status:"not_ready",cutoff,processed:0,erased:0,failed:0,remaining:0,ledgerPreserved:true};
 const hasBookings=await tableExists(db,"canonical_bookings");
 const sql=hasBookings
  ?"SELECT c.id customer_id,c.updated_at crm_updated_at,MAX(b.updated_at) booking_updated_at FROM crm_contacts c JOIN canonical_customers cc ON cc.id=c.id LEFT JOIN canonical_bookings b ON b.customer_id=c.id WHERE c.updated_at<? GROUP BY c.id,c.updated_at HAVING COALESCE(MAX(b.updated_at),0)<? ORDER BY c.updated_at ASC LIMIT ?"
  :"SELECT c.id customer_id,c.updated_at crm_updated_at,NULL booking_updated_at FROM crm_contacts c JOIN canonical_customers cc ON cc.id=c.id WHERE c.updated_at<? ORDER BY c.updated_at ASC LIMIT ?";
 const query=hasBookings?db.prepare(sql).bind(cutoff,cutoff,limit):db.prepare(sql).bind(cutoff,limit),rows=await query.all<Row>();
 let erased=0,failed=0;const results:Array<Record<string,unknown>>=[];
 for(const row of rows.results){const customerId=text(row.customer_id);if(!customerId)continue;try{const result=await eraseCustomerPersonalData(db,{customerId,idempotencyKey:`dpdp-retention:${customerId}:${cutoff}`,requestedBy,reason:"automated_retention_inactive_over_3_years",now:asOf});erased++;results.push({customerIdHash:result.customerIdHash,status:result.status,ledgerPreserved:result.ledgerPreserved,duplicatePrevented:result.duplicatePrevented});}catch(error){failed++;results.push({customerIdHash:null,status:"FAILED",error:error instanceof Error?error.message:String(error)});}}
 const countSql=hasBookings
  ?"SELECT COUNT(*) remaining FROM (SELECT c.id FROM crm_contacts c JOIN canonical_customers cc ON cc.id=c.id LEFT JOIN canonical_bookings b ON b.customer_id=c.id WHERE c.updated_at<? GROUP BY c.id,c.updated_at HAVING COALESCE(MAX(b.updated_at),0)<?)"
  :"SELECT COUNT(*) remaining FROM crm_contacts c JOIN canonical_customers cc ON cc.id=c.id WHERE c.updated_at<?";
 const remainingRow=hasBookings?await db.prepare(countSql).bind(cutoff,cutoff).first<Row>():await db.prepare(countSql).bind(cutoff).first<Row>();
 return{status:failed?"partial_failure":"completed",cutoff,retentionYears:3,processed:rows.results.length,erased,failed,remaining:Number(remainingRow?.remaining||0),ledgerPreserved:failed===0,results};
}
