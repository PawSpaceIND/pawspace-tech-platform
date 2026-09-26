import {parsePaymentEnvironment} from "./payment-environment";
import {REDEEM_RUPEE_PER_POINT} from "./booking-credit-application";

type Query={sql:string;binds:unknown[]};
type FundingRow={quoteId:string;bookingId:string;totalAmount:number;amountDueNow:number;paymentMode:string;cashPaid:number;creditPaid:number;amountPaid:number;valid:number};
const round2=(value:number)=>Math.round(value*100)/100;

/** One funding projection for service guards, commercial views, provider jobs and finance.
 * SQL expressions are retained so the lifecycle transaction re-reads funding atomically.
 * Optional ledgers that do not exist represent unused instruments, never fabricated money.
 */
async function trainingFundingQuery(db:D1Database):Promise<Query>{
 const {env}=await import("cloudflare:workers");
 const environment=parsePaymentEnvironment(env as unknown as Record<string,unknown>);
 const rows=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('payment_reconciliation_records','pawspace_wallet_ledger','paw_points_ledger','review_reward_codes')").all<{name:string}>();
 const tables=new Set(rows.results.map(row=>row.name));
 const gateway=tables.has('payment_reconciliation_records');
 const noGateway=gateway?"NOT EXISTS(SELECT 1 FROM payment_reconciliation_records r WHERE r.booking_id=b.id)":"1";
 const gatewayValid="r.gateway='razorpay' AND r.environment=? AND r.currency='INR' AND pay.currency='INR' AND pay.status IN ('captured','partially_refunded','refunded') AND r.gateway_status IN ('captured','partially_refunded','refunded') AND r.reconciliation_status IN ('matched','partially_captured','partially_refunded') AND r.variance_amount=0 AND r.captured_amount>=0 AND r.refunded_amount>=0 AND r.refunded_amount<=r.captured_amount AND ((pay.status<>'refunded' AND r.gateway_status<>'refunded') OR r.refunded_amount=r.captured_amount)";
 const gatewayCash=gateway?`(SELECT MAX(r.captured_amount-r.refunded_amount) FROM payment_reconciliation_records r WHERE r.booking_id=b.id AND r.payment_id=pay.id AND ${gatewayValid})`:"NULL";
 // Gateway records supersede sandbox attestations, including failed or refunded records.
 const legacy=`CASE WHEN ${environment==='sandbox'?'1':'0'} AND ${noGateway} AND COALESCE(pay.status,'created') NOT IN ('refunded','partially_refunded','failed','cancelled') AND a.environment='sandbox' AND a.currency='INR' AND a.amount>=0 AND ((a.status='FULLY_PAID' AND ROUND(a.amount*100)>=ROUND(q.total_amount*100)) OR (a.status='PARTIALLY_PAID' AND ROUND(a.amount*100)<ROUND(q.total_amount*100))) THEN a.amount ELSE 0 END`;
 const wallet=tables.has('pawspace_wallet_ledger')?"COALESCE((SELECT SUM(applied_value) FROM pawspace_wallet_ledger WHERE entry_type='redeem' AND source_type='booking' AND source_id=b.id AND customer_id=b.customer_id),0)":"0";
 const points=tables.has('paw_points_ledger')?`COALESCE((SELECT SUM(-points)*${REDEEM_RUPEE_PER_POINT} FROM paw_points_ledger WHERE entry_type IN ('redeemed','cancellation_restore') AND booking_id=b.id AND customer_id=b.customer_id),0)`:"0";
 const reward=tables.has('review_reward_codes')?"COALESCE((SELECT SUM(COALESCE(applied_amount,discount_amount)) FROM review_reward_codes WHERE status='redeemed' AND redeemed_booking_id=b.id AND customer_id=b.customer_id AND discount_amount>0),0)":"0";
 const credit=`ROUND(MAX(0,${wallet})+MAX(0,${points})+MAX(0,${reward}),2)`;
 const quoteValid="b.service_code='dog_training' AND b.currency='INR' AND q.total_amount=b.total_amount AND q.total_amount>=0 AND q.amount_due_now>=0 AND (q.total_amount=0 OR q.amount_due_now>0) AND q.amount_due_now<=q.total_amount";
 const raw=`SELECT q.id quoteId,b.id bookingId,q.total_amount totalAmount,q.amount_due_now amountDueNow,q.payment_mode paymentMode,CASE WHEN ${quoteValid} THEN 1 ELSE 0 END valid,${gatewayCash} gatewayCash,${legacy} legacyCash,${credit} credits,CASE WHEN ${noGateway} AND COALESCE(pay.status,'created') NOT IN ('refunded','partially_refunded','failed','cancelled') THEN 1 ELSE 0 END legacyAllowed FROM canonical_bookings b JOIN training_booking_quote_links l ON l.booking_id=b.id JOIN training_commercial_quotes q ON q.id=l.quote_id LEFT JOIN booking_payments pay ON pay.booking_id=b.id LEFT JOIN training_quote_payment_attestations a ON a.quote_id=q.id`;
 const funds=`SELECT *,CASE WHEN valid=1 THEN ROUND(COALESCE(gatewayCash,legacyCash),2) ELSE 0 END cashPaid,CASE WHEN valid=1 AND (gatewayCash IS NOT NULL OR legacyAllowed=1) THEN credits ELSE 0 END creditPaid FROM (${raw})`;
 return{sql:`SELECT *,ROUND(cashPaid+creditPaid,2) amountPaid FROM (${funds})`,binds:gateway?[environment]:[]};
}

/** The same predicate runs before a service action and inside its transaction. */
export async function trainingPaymentPredicate(db:D1Database,bookingId:string,fullyPaid:boolean):Promise<Query>{
 const funding=await trainingFundingQuery(db);
 const required=fullyPaid?"totalAmount":"CASE WHEN paymentMode IN ('split','deposit') THEN amountDueNow ELSE totalAmount END";
 return{sql:`EXISTS(SELECT 1 FROM (${funding.sql}) WHERE bookingId=? AND valid=1 AND ROUND(amountPaid*100)>=ROUND((${required})*100))`,binds:[...funding.binds,bookingId]};
}

function paymentState(row:FundingRow|null){
 if(!row)return{status:'UNPAID' as const,amountPaid:0,cashPaid:0,creditPaid:0,remainingAmount:null,totalAmount:0,paymentMode:''};
 const amountPaid=Number(row.amountPaid),totalAmount=Number(row.totalAmount);
 const status=row.valid===1&&Math.round(amountPaid*100)>=Math.round(totalAmount*100)?'FULLY_PAID' as const:amountPaid>0?'PARTIALLY_PAID' as const:'UNPAID' as const;
 return{status,amountPaid,cashPaid:Number(row.cashPaid),creditPaid:Number(row.creditPaid),remainingAmount:Math.max(0,round2(totalAmount-amountPaid)),totalAmount,paymentMode:row.paymentMode};
}

export async function trainingBookingPaymentState(db:D1Database,bookingId:string){
 const funding=await trainingFundingQuery(db);
 return paymentState(await db.prepare(`SELECT * FROM (${funding.sql}) WHERE bookingId=?`).bind(...funding.binds,bookingId).first<FundingRow>());
}

/** trainingBookingPaymentState for many bookings in one funding read, so a provider job list costs the same D1 calls at any size. */
export async function trainingBookingPaymentStates(db:D1Database,bookingIds:readonly string[]){
 const states=new Map<string,ReturnType<typeof paymentState>>();
 if(!bookingIds.length)return states;
 const funding=await trainingFundingQuery(db);
 const rows=await db.prepare(`SELECT * FROM (${funding.sql}) WHERE bookingId IN (SELECT value FROM json_each(?))`).bind(...funding.binds,JSON.stringify(bookingIds)).all<FundingRow>();
 for(const row of rows.results)if(!states.has(String(row.bookingId)))states.set(String(row.bookingId),paymentState(row));
 for(const bookingId of bookingIds)if(!states.has(bookingId))states.set(bookingId,paymentState(null));
 return states;
}
