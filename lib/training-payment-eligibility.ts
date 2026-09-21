import {parsePaymentEnvironment} from "./payment-environment";

type Predicate={sql:string;binds:unknown[]};
/** The same predicate runs before a service action and inside its transaction. */
export async function trainingPaymentPredicate(db:D1Database,bookingId:string,fullyPaid:boolean):Promise<Predicate>{
 const {env}=await import("cloudflare:workers");
 const environment=parsePaymentEnvironment(env as unknown as Record<string,unknown>);
 const hasReconciliation=Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='payment_reconciliation_records'").first());
 const required=fullyPaid?"q.total_amount":"CASE WHEN q.payment_mode IN ('split','deposit') THEN q.amount_due_now ELSE q.total_amount END";
 const covers=(amount:string)=>`ROUND(100*(${amount}))>=ROUND(100*(${required}))`;
 // An existing gateway record always wins, including zero, failed or refunded captures.
 // A status flag or the submitted booking total is never payment evidence.
 const gateway=hasReconciliation?`EXISTS(SELECT 1 FROM payment_reconciliation_records r JOIN booking_payments pay ON pay.id=r.payment_id AND pay.booking_id=r.booking_id WHERE r.booking_id=b.id AND r.gateway='razorpay' AND r.environment=? AND r.currency='INR' AND pay.status IN ('captured','partially_refunded') AND r.gateway_status IN ('captured','partially_refunded') AND r.reconciliation_status IN ('matched','partially_captured','partially_refunded') AND r.variance_amount=0 AND r.captured_amount>=0 AND r.refunded_amount>=0 AND ${covers("r.captured_amount-r.refunded_amount")})`:"0";
 const noGateway=hasReconciliation?"NOT EXISTS(SELECT 1 FROM payment_reconciliation_records r WHERE r.booking_id=b.id)":"1";
 const sandbox=`(?=1 AND ${noGateway} AND NOT EXISTS(SELECT 1 FROM booking_payments pay WHERE pay.booking_id=b.id AND pay.status IN ('refunded','partially_refunded','failed','cancelled')) AND EXISTS(SELECT 1 FROM training_quote_payment_attestations a WHERE a.quote_id=q.id AND a.environment='sandbox' AND a.currency='INR' AND (a.status='FULLY_PAID'${fullyPaid?'':" OR (q.payment_mode IN ('split','deposit') AND a.status='PARTIALLY_PAID')"}) AND a.amount>=0 AND ${covers("a.amount")}))`;
 return {sql:`EXISTS(SELECT 1 FROM canonical_bookings b JOIN training_booking_quote_links l ON l.booking_id=b.id JOIN training_commercial_quotes q ON q.id=l.quote_id WHERE b.id=? AND b.service_code='dog_training' AND q.total_amount=b.total_amount AND q.total_amount>=0 AND q.amount_due_now>=0 AND (q.total_amount=0 OR q.amount_due_now>0) AND q.amount_due_now<=q.total_amount AND ((${gateway}) OR ${sandbox}))`,binds:[bookingId,...(hasReconciliation?[environment]:[]),environment==='sandbox'?1:0]};
}
