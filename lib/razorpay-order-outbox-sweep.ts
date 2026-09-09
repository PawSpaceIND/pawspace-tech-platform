import{executeRazorpayOrderOutbox}from"./financial-lifecycle";
import{parsePaymentEnvironment}from"./payment-environment";
import{runAutomaticBookingRefundSweep}from"./automatic-booking-refund";

type Db=D1Database;type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();

/**
 * Drain due CREATE_RAZORPAY_ORDER entries and eligible automatic booking refunds from the scheduled
 * payment sweep. Environment validation happens before any provider-bound work, so a missing/invalid
 * payment environment cannot strand an order lease or initiate a refund.
 */
export async function runRazorpayOrderOutboxSweep(db:Db,env:Record<string,unknown>,input:{asOf?:number;limit?:number;workerId?:string}={}){
 const asOf=input.asOf??Date.now(),limit=Math.max(1,Math.min(100,input.limit??25));
 try{parsePaymentEnvironment(env);}catch(error){return{processed:0,succeeded:0,failed:0,reconciliationRequired:0,blocked:true,reason:error instanceof Error?error.message:String(error),refunds:null,results:[] as Array<Record<string,unknown>>};}
 const table=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='financial_outbox'").first<Row>();
 let processed=0,succeeded=0,failed=0,reconciliationRequired=0;const results:Array<Record<string,unknown>>=[];
 if(table){
  const rows=await db.prepare("SELECT id FROM financial_outbox WHERE event_type='CREATE_RAZORPAY_ORDER' AND status IN ('PENDING','RETRY') AND next_attempt_at<=? ORDER BY next_attempt_at ASC,created_at ASC LIMIT ?").bind(asOf,limit).all<Row>();
  processed=rows.results.length;
  const prefix=text(input.workerId)||`scheduled-financial-outbox:${asOf}:${crypto.randomUUID()}`;
  for(const row of rows.results){const outboxId=text(row.id);if(!outboxId)continue;try{const result=await executeRazorpayOrderOutbox(db,env,{outboxId,workerId:`${prefix}:${outboxId}`});results.push({outboxId,...result});if(result.claimed&&"connected"in result&&result.connected)succeeded++;else if(result.claimed&&"reconciliationRequired"in result&&result.reconciliationRequired)reconciliationRequired++;else if(result.claimed)failed++;}catch(error){failed++;results.push({outboxId,claimed:false,error:error instanceof Error?error.message:String(error)});}}
 }
 const refunds=await runAutomaticBookingRefundSweep(db,env,{asOf,limit});
 return{processed,succeeded,failed,reconciliationRequired,blocked:false,skipped:!table,refunds,results};
}
