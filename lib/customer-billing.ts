import{paymentStageAmount}from"./payment-stage-amount";

type Row=Record<string,unknown>;
export type CustomerBilling={paymentsAvailable:boolean;invoicesAvailable:boolean;payments:Row[];invoices:Row[]};
/** Missing schema is unavailable; failed reads propagate rather than showing a zero balance. */
export async function readCustomerBilling(db:D1Database,customerId:string):Promise<CustomerBilling>{
 if(!customerId.trim())throw new Error('Customer identity is required');
 const schema=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('canonical_bookings','booking_payments','booking_invoices')").all<{name:string}>();
 const names=new Set(schema.results.map(row=>row.name));
 const paymentsAvailable=names.has('canonical_bookings')&&names.has('booking_payments'),invoicesAvailable=names.has('canonical_bookings')&&names.has('booking_invoices');
 const storedPayments=paymentsAvailable?(await db.prepare("SELECT p.id,p.booking_id,p.amount,p.amount_due_now,p.currency,p.method,p.status,p.gateway,p.created_at,b.package_name,b.service_code FROM booking_payments p JOIN canonical_bookings b ON b.id=p.booking_id WHERE p.customer_id=? AND b.customer_id=? ORDER BY p.created_at DESC LIMIT 100").bind(customerId,customerId).all<Row>()).results:[];
 const payments:Row[]=[];
 for(const payment of storedPayments){
  const stage=await paymentStageAmount(db,String(payment.booking_id));
  payments.push(stage?{...payment,stored_amount_due_now:Number(payment.amount_due_now||0),amount_due_now:stage.dueNow,payment_stage:stage.stage,applied_credits:Number(stage.appliedCredits||0)}:payment);
 }
 const invoices=invoicesAvailable?(await db.prepare("SELECT i.id,i.booking_id,i.invoice_number,i.status,i.currency,i.gross_amount,i.tax_amount,i.net_amount,i.issued_at,b.package_name,b.service_code FROM booking_invoices i JOIN canonical_bookings b ON b.id=i.booking_id WHERE i.customer_id=? AND b.customer_id=? ORDER BY i.created_at DESC LIMIT 100").bind(customerId,customerId).all<Row>()).results:[];
 return{paymentsAvailable,invoicesAvailable,payments,invoices};
}
