import {hasPermission} from './platform-security';
import {COLLECTED_PAYMENT_STATUSES} from './collected-funds';
type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??'').trim();
const valid=(value:unknown)=>value!==null&&value!==undefined&&Number.isFinite(Number(value))&&Number(value)>=0;
/** Internal collector adapter, called only after CRM city/domain/assignment authorization.
 * Both report and finance grants are required. Every money row binds payment, reconciliation,
 * booking and canonical customer identity/city. No schema initialization or writes.
 * Reconciliation proves a capture, never full settlement or AI attribution.
 */
export async function readCustomerSalesPaymentEvidence(db:D1Database,input:{permissions:string[];customerId:string;cityId:string;asOf:number}){
 if(!hasPermission(input.permissions,'finance.view')||!hasPermission(input.permissions,'reports.view'))return{status:'restricted',records:null,purchases:null} as const;
 if(!input.customerId||!input.cityId||!Number.isFinite(input.asOf)||input.asOf<0)throw new Error('Invalid authorized payment evidence context');
 const select=`SELECT p.id payment_id,p.status payment_status,p.updated_at payment_updated_at,
 b.id booking_id,b.service_code,b.status booking_status,b.updated_at booking_updated_at,
 r.captured_amount,r.refunded_amount,r.updated_at reconciled_at
 FROM canonical_customers c JOIN canonical_bookings b ON b.customer_id=c.id
 JOIN booking_payments p ON p.booking_id=b.id AND p.customer_id=c.id
 LEFT JOIN payment_reconciliation_records r ON r.payment_id=p.id AND r.booking_id=b.id
 WHERE c.id=? AND c.merged_into IS NULL AND lower(c.city_id)=lower(?) AND lower(b.city_id)=lower(?)`;
 try{
  const bindings=[input.customerId,input.cityId,input.cityId];
  const recent=(await db.prepare(select+' ORDER BY p.updated_at DESC,p.id DESC LIMIT 20').bind(...bindings).all<Row>()).results;
  // Old retained purchases must not be hidden by a run of recent unpaid inquiries/bookings.
  const historical=(await db.prepare(select+" AND r.captured_amount>r.refunded_amount AND r.refunded_amount>=0 AND r.updated_at>=p.updated_at AND r.updated_at<=? AND p.updated_at>=0 AND p.status IN ('captured','paid','partially_refunded') AND b.status NOT IN ('draft','cancelled','refunded') ORDER BY r.updated_at DESC,p.id DESC LIMIT 2").bind(...bindings,input.asOf).all<Row>()).results;
  const records=[...new Map([...recent,...historical].map(row=>[text(row.payment_id),row])).values()].map(row=>{
   const status=text(row.payment_status),reconciledAt=Number(row.reconciled_at);
   const reconciliationAvailable=valid(row.captured_amount)&&valid(row.refunded_amount)&&Number(row.refunded_amount)<=Number(row.captured_amount)&&valid(row.reconciled_at)&&reconciledAt<=input.asOf&&valid(row.payment_updated_at)&&Number(row.payment_updated_at)<=input.asOf&&reconciledAt>=Number(row.payment_updated_at);
   const captured=reconciliationAvailable?Number(row.captured_amount)>0:null;
   const retainedPurchase=reconciliationAvailable?Number(row.captured_amount)>Number(row.refunded_amount)&&COLLECTED_PAYMENT_STATUSES.includes(status as typeof COLLECTED_PAYMENT_STATUSES[number])&&status!=='refunded':null;
   return{ref:text(row.payment_id),bookingId:text(row.booking_id),serviceCode:text(row.service_code),bookingStatus:text(row.booking_status),paymentStatus:status,reconciledAt:reconciliationAvailable?reconciledAt:null,captureVerified:captured,retainedPurchaseVerified:retainedPurchase,refundRecorded:reconciliationAvailable?Number(row.refunded_amount)>0:null,fullyPaid:null,observedAt:Number(row.booking_updated_at)};
  });
  const purchases=records.filter(row=>row.retainedPurchaseVerified===true).map(row=>({id:row.bookingId,serviceCode:row.serviceCode,status:row.bookingStatus,verifiedPurchase:true,observedAt:row.reconciledAt!}));
  return{status:'available',records,purchases} as const;
 }catch{return{status:'unavailable',records:null,purchases:null} as const;}
}
