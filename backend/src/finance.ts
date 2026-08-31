import { createHash, randomUUID } from "node:crypto";
import type { AuditEvent, Booking, CashCollection, Payment, PaymentMethod, PlatformRepository, ProviderEarning, ProviderPayout, Refund, RequestActor, TaxInvoice } from "./domain.js";
import type { IntegrationGateway } from "./integrations.js";

const id=(prefix:string)=>`${prefix}_${randomUUID().replaceAll("-","").slice(0,16)}`;
const stableId=(prefix:string,key:string)=>`${prefix}_${createHash("sha256").update(key).digest("hex").slice(0,16)}`;
const now=()=>new Date().toISOString();
const roundMoney=(value:number)=>Math.round(value*100)/100;
const fail=(message:string,statusCode=422):never=>{throw Object.assign(new Error(message),{statusCode});};
const systemActor:RequestActor={id:"finance_system",role:"super_admin",cityId:"system"};
const financeAudit=(action:string,entityType:string,entityId:string,cityId:string,metadata:Record<string,unknown>):AuditEvent=>({id:id("audit"),occurredAt:now(),actorId:systemActor.id,actorRole:systemActor.role,action,entityType,entityId,cityId,metadata});

export function calculateInclusiveGst(grossAmount:number,interstate=false){
  const taxableAmount=roundMoney(grossAmount/1.18);
  const gst=roundMoney(grossAmount-taxableAmount);
  return {grossAmount:roundMoney(grossAmount),taxableAmount,cgst:interstate?0:roundMoney(gst/2),sgst:interstate?0:roundMoney(gst/2),igst:interstate?gst:0,gstRate:18 as const};
}

async function postJournal(repository:PlatformRepository,input:{payment:Payment;kind:"payment_captured"|"refund_completed";amount:number;externalId:string;interstate?:boolean}){
  const tax=calculateInclusiveGst(input.amount,input.interstate);const gst=roundMoney(tax.cgst+tax.sgst+tax.igst);
  const lines=input.kind==="payment_captured"?[
    {account:"razorpay_clearing",debit:tax.grossAmount,credit:0},
    {account:"service_revenue",debit:0,credit:tax.taxableAmount},
    {account:"gst_output",debit:0,credit:gst},
  ]:[
    {account:"service_revenue",debit:tax.taxableAmount,credit:0},
    {account:"gst_output",debit:gst,credit:0},
    {account:"razorpay_clearing",debit:0,credit:tax.grossAmount},
  ];
  const debitTotal=roundMoney(lines.reduce((sum,x)=>sum+x.debit,0)),creditTotal=roundMoney(lines.reduce((sum,x)=>sum+x.credit,0)),variance=roundMoney(debitTotal-creditTotal);
  if(variance!==0)fail("Accounting journal is not balanced",500);
  const journalKey=`${input.kind}:${input.externalId}`;const prior=await repository.listAudit("finance_journal",journalKey);if(prior.length)return prior[0]!;
  const event=financeAudit("finance.journal_posted","finance_journal",journalKey,input.payment.cityId,{journalType:input.kind,paymentId:input.payment.id,bookingId:input.payment.bookingId,externalId:input.externalId,currency:"INR",lines,debitTotal,creditTotal,variance});
  await repository.appendAudit(event);return event;
}

export async function createPayment(repository:PlatformRepository,input:{booking:Booking;customerId:string;method:PaymentMethod;mode:"prepaid"|"pay_after_service";idempotencyKey:string},gateway?:Pick<IntegrationGateway,"createPaymentOrder">){
  const existing=await repository.findPaymentByIdempotencyKey(input.idempotencyKey);if(existing)return {payment:existing,duplicatePrevented:true};
  const timestamp=now();let gatewayOrderId:string|undefined;
  if(input.method!=="cash"){
    if(!gateway)fail("Razorpay order adapter is required",503);
    const order=await gateway.createPaymentOrder(input.booking.totalAmount,input.idempotencyKey);
    if(order.currency!=="INR"||order.amount!==Math.round(input.booking.totalAmount*100))fail("Razorpay order amount/currency mismatch",502);
    gatewayOrderId=order.id;
  }
  const payment:Payment={id:id("pay"),bookingId:input.booking.id,customerId:input.customerId,cityId:input.booking.cityId,amount:input.booking.totalAmount,currency:"INR",method:input.method,mode:input.mode,status:"created",gateway:input.method==="cash"?"cash":"razorpay",gatewayOrderId,idempotencyKey:input.idempotencyKey,createdAt:timestamp,updatedAt:timestamp};
  await repository.createPayment(payment);return {payment,duplicatePrevented:false};
}

export async function capturePayment(repository:PlatformRepository,payment:Payment,gatewayPaymentId?:string){
  if(payment.status==="captured"||payment.status==="partially_refunded"||payment.status==="refunded"){
    if(gatewayPaymentId&&payment.gatewayPaymentId&&gatewayPaymentId!==payment.gatewayPaymentId)fail("Captured payment gateway id conflict",409);
    return payment;
  }
  if(payment.gateway==="razorpay"&&(!payment.gatewayOrderId||!gatewayPaymentId))fail("Razorpay capture requires provider order and payment ids",409);
  const timestamp=now();const captured=await repository.updatePayment(payment.id,{status:"captured",gatewayPaymentId,capturedAt:timestamp,updatedAt:timestamp});
  if(captured&&captured.gateway==="razorpay"&&captured.gatewayPaymentId)await postJournal(repository,{payment:captured,kind:"payment_captured",amount:captured.amount,externalId:captured.gatewayPaymentId});
  return captured;
}

export async function reconcileRazorpayPayment(repository:PlatformRepository,payment:Payment,provider:{id:string;orderId:string;amount:number;currency:string;status:string}){
  if(payment.gateway!=="razorpay"||!payment.gatewayOrderId||!payment.gatewayPaymentId)fail("Razorpay reconciliation requires captured provider identifiers",409);
  const providerAmount=roundMoney(provider.amount/100),variance=roundMoney(providerAmount-payment.amount);
  const matched=provider.id===payment.gatewayPaymentId&&provider.orderId===payment.gatewayOrderId&&provider.currency==="INR"&&provider.status==="captured"&&variance===0;
  const key=`${payment.id}:${provider.id}`;const existing=await repository.listAudit("payment_reconciliation",key);if(existing.length)return {matched:Boolean(existing[0]!.metadata.matched),variance:Number(existing[0]!.metadata.variance),providerAmount:Number(existing[0]!.metadata.providerAmount)};
  await repository.appendAudit(financeAudit("payment.reconciled","payment_reconciliation",key,payment.cityId,{paymentId:payment.id,gatewayOrderId:payment.gatewayOrderId,gatewayPaymentId:payment.gatewayPaymentId,internalAmount:payment.amount,providerAmount,variance,providerStatus:provider.status,matched}));
  if(!matched)fail(`Razorpay reconciliation mismatch: variance ${variance}`,409);
  return {matched,variance,providerAmount};
}

export async function issueInvoice(repository:PlatformRepository,payment:Payment,placeOfSupply="Karnataka",interstate=false){
  if(payment.status!=="captured"&&payment.status!=="partially_refunded"&&payment.status!=="refunded")fail("Invoice requires a captured payment",409);
  const existing=await repository.getInvoiceByBooking(payment.bookingId);if(existing)return existing;
  const tax=calculateInclusiveGst(payment.amount,interstate);const timestamp=now();
  const invoice:TaxInvoice={id:id("inv"),invoiceNumber:`PS/${new Date().getFullYear()}/${String(Date.now()).slice(-8)}`,bookingId:payment.bookingId,paymentId:payment.id,customerId:payment.customerId,cityId:payment.cityId,placeOfSupply,...tax,issuedAt:timestamp,status:"issued"};
  return repository.createInvoice(invoice);
}

export async function requestRefund(repository:PlatformRepository,payment:Payment,actor:RequestActor,amount:number,reason:string,idempotencyKey?:string,gateway?:Pick<IntegrationGateway,"refundPayment">){
  if(!["captured","partially_refunded"].includes(payment.status))fail("Refund requires a captured payment",409);
  if(idempotencyKey){const prior=await repository.listAudit("refund_idempotency",idempotencyKey);const refundId=prior[0]?.metadata.refundId;if(typeof refundId==="string"){const found=(await repository.listRefunds(payment.id)).find(x=>x.id===refundId);if(found)return found;}}
  const existingRefunds=await repository.listRefunds(payment.id);const already=existingRefunds.filter(x=>["approved","processing","completed"].includes(x.status)).reduce((sum,x)=>sum+x.amount,0);
  if(amount<=0||amount>payment.amount-already)fail("Refund exceeds refundable balance");
  const privileged=actor.role==="finance"||actor.role==="super_admin";const timestamp=now();let status:Refund["status"]=privileged?"approved":"requested",gatewayRefundId:string|undefined;
  if(privileged&&payment.gateway==="razorpay"){
    if(!gateway||!payment.gatewayPaymentId||!idempotencyKey)fail("Razorpay refund requires provider adapter, payment id and idempotency key",503);
    const providerRefund=await gateway.refundPayment(payment.gatewayPaymentId,amount,idempotencyKey);gatewayRefundId=providerRefund.id;status=providerRefund.status==="processed"?"completed":providerRefund.status==="failed"?"failed":"processing";
  }
  const refund:Refund={id:idempotencyKey?stableId("refund",idempotencyKey):id("refund"),paymentId:payment.id,bookingId:payment.bookingId,amount,reason,status,gatewayRefundId,requestedBy:actor.id,approvedBy:privileged?actor.id:undefined,createdAt:timestamp,updatedAt:timestamp};
  await repository.createRefund(refund);if(idempotencyKey)await repository.appendAudit(financeAudit("refund.idempotency_recorded","refund_idempotency",idempotencyKey,payment.cityId,{refundId:refund.id,paymentId:payment.id,gatewayRefundId}));
  if(status==="completed"&&gatewayRefundId){const completedTotal=already+amount;await repository.updatePayment(payment.id,{status:completedTotal===payment.amount?"refunded":"partially_refunded",updatedAt:timestamp});await postJournal(repository,{payment,kind:"refund_completed",amount,externalId:gatewayRefundId});}
  return refund;
}

export async function recordCash(repository:PlatformRepository,input:{booking:Booking;payment:Payment;providerId:string;collectedAt:string}){
  const collection:CashCollection={id:id("cash"),bookingId:input.booking.id,paymentId:input.payment.id,providerId:input.providerId,cityId:input.booking.cityId,amount:input.payment.amount,collectedAt:input.collectedAt,status:"collected"};return repository.createCashCollection(collection);
}

export async function reconcileCash(repository:PlatformRepository,collection:CashCollection,depositedAmount:number,note?:string){
  const status=depositedAmount===collection.amount?"reconciled":depositedAmount<collection.amount?"short":"excess";return repository.updateCashCollection(collection.id,{status,depositedAt:now(),reconciledAt:now(),reconciliationNote:note});
}

export async function createProviderEarning(repository:PlatformRepository,booking:Booking,input:{baseEarning:number;incentive?:number;deductions?:number;completedAt:string}){
  if(!booking.providerId)fail("Booking has no assigned provider");
  const incentive=input.incentive??0,deductions=input.deductions??0;const timestamp=now();
  const earning:ProviderEarning={id:id("earn"),bookingId:booking.id,providerId:booking.providerId,cityId:booking.cityId,serviceValue:booking.totalAmount,baseEarning:input.baseEarning,incentive,deductions,netPayable:roundMoney(input.baseEarning+incentive-deductions),eligibleAt:new Date(new Date(input.completedAt).getTime()+5*24*60*60*1000).toISOString(),status:"cooling",createdAt:timestamp,updatedAt:timestamp};
  await repository.createEarning(earning);await repository.appendAudit(financeAudit("finance.journal_posted","finance_journal",`provider_earning:${earning.id}`,booking.cityId,{journalType:"provider_earning",bookingId:booking.id,providerId:earning.providerId,lines:[{account:"provider_service_cost",debit:earning.netPayable,credit:0},{account:"provider_payable",debit:0,credit:earning.netPayable}],debitTotal:earning.netPayable,creditTotal:earning.netPayable,variance:0}));return earning;
}

export async function createPayout(repository:PlatformRepository,input:{providerId:string;cityId:string;idempotencyKey:string;asOf?:string},gateway?:Pick<IntegrationGateway,"createPayout">){
  const existing=await repository.findPayoutByIdempotencyKey(input.idempotencyKey);if(existing)return {payout:existing,duplicatePrevented:true};
  const asOf=new Date(input.asOf??now());const earnings=(await repository.listEarnings(input.providerId)).filter(x=>x.status==="eligible"||x.status==="cooling"&&new Date(x.eligibleAt)<=asOf);
  if(!earnings.length)fail("No eligible earnings for payout");if(!gateway)fail("RazorpayX payout adapter is required",503);
  const amount=roundMoney(earnings.reduce((sum,x)=>sum+x.netPayable,0));const providerPayout=await gateway.createPayout(amount,input.providerId,input.idempotencyKey);if(providerPayout.currency!=="INR"||providerPayout.amount!==Math.round(amount*100))fail("RazorpayX payout amount/currency mismatch",502);
  const status:ProviderPayout["status"]=providerPayout.status==="processed"?"paid":providerPayout.status==="failed"||providerPayout.status==="rejected"||providerPayout.status==="cancelled"?"failed":providerPayout.status==="processing"?"processing":"queued";
  const timestamp=now();const payout:ProviderPayout={id:id("payout"),providerId:input.providerId,cityId:input.cityId,earningIds:earnings.map(x=>x.id),amount,gateway:"razorpayx",gatewayPayoutId:providerPayout.id,status,idempotencyKey:input.idempotencyKey,scheduledAt:timestamp,paidAt:status==="paid"?timestamp:undefined,createdAt:timestamp,updatedAt:timestamp};
  await repository.createPayout(payout);if(status!=="failed")await Promise.all(earnings.map(x=>repository.updateEarning(x.id,{status:status==="paid"?"paid":"scheduled",payoutId:payout.id,updatedAt:timestamp})));
  if(status==="paid")await repository.appendAudit(financeAudit("finance.journal_posted","finance_journal",`provider_payout:${providerPayout.id}`,input.cityId,{journalType:"provider_payout",providerId:input.providerId,payoutId:payout.id,externalId:providerPayout.id,lines:[{account:"provider_payable",debit:amount,credit:0},{account:"razorpayx_clearing",debit:0,credit:amount}],debitTotal:amount,creditTotal:amount,variance:0}));
  return {payout,duplicatePrevented:false};
}
