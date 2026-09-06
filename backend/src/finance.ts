import { randomUUID } from "node:crypto";
import type { Booking, CashCollection, Payment, PaymentMethod, PlatformRepository, ProviderEarning, ProviderPayout, Refund, RequestActor, TaxInvoice } from "./domain.js";
import { allocateInvoiceNumber, isDuplicateKeyError } from "./invoice-numbering.js";

const id=(prefix:string)=>`${prefix}_${randomUUID().replaceAll("-","").slice(0,16)}`;
const now=()=>new Date().toISOString();
const roundMoney=(value:number)=>Math.round(value*100)/100;

export function calculateInclusiveGst(grossAmount:number,interstate=false){
  const taxableAmount=roundMoney(grossAmount/1.18);
  const gst=roundMoney(grossAmount-taxableAmount);
  return {grossAmount:roundMoney(grossAmount),taxableAmount,cgst:interstate?0:roundMoney(gst/2),sgst:interstate?0:roundMoney(gst/2),igst:interstate?gst:0,gstRate:18 as const};
}

export async function createPayment(repository:PlatformRepository,input:{booking:Booking;customerId:string;method:PaymentMethod;mode:"prepaid"|"pay_after_service";idempotencyKey:string;gatewayOrderId?:string}){
  const existing=await repository.findPaymentByIdempotencyKey(input.idempotencyKey);if(existing)return {payment:existing,duplicatePrevented:true};
  const timestamp=now();
  const payment:Payment={id:id("pay"),bookingId:input.booking.id,customerId:input.customerId,cityId:input.booking.cityId,amount:input.booking.totalAmount,currency:"INR",method:input.method,mode:input.mode,status:"created",gateway:input.method==="cash"?"cash":"razorpay",gatewayOrderId:input.gatewayOrderId,idempotencyKey:input.idempotencyKey,createdAt:timestamp,updatedAt:timestamp};
  await repository.createPayment(payment);return {payment,duplicatePrevented:false};
}

export async function capturePayment(repository:PlatformRepository,payment:Payment,gatewayPaymentId?:string){
  const timestamp=now();return repository.updatePayment(payment.id,{status:"captured",gatewayPaymentId,capturedAt:timestamp,updatedAt:timestamp});
}

export async function issueInvoice(repository:PlatformRepository,payment:Payment,placeOfSupply="Karnataka",interstate=false){
  const existing=await repository.getInvoiceByBooking(payment.bookingId);if(existing)return existing;
  const tax=calculateInclusiveGst(payment.amount,interstate);const timestamp=now();
  const invoice:TaxInvoice={id:id("inv"),invoiceNumber:await allocateInvoiceNumber(repository,new Date(timestamp)),bookingId:payment.bookingId,paymentId:payment.id,customerId:payment.customerId,cityId:payment.cityId,placeOfSupply,...tax,issuedAt:timestamp,status:"issued"};
  try{return await repository.createInvoice(invoice);}catch(error){
    // A concurrent retry for the same booking can race the initial existence read. The DB unique
    // constraint is authoritative: if another writer won, return that canonical invoice rather
    // than forking the booking or turning an idempotent replay into a 500.
    if(isDuplicateKeyError(error)){const canonical=await repository.getInvoiceByBooking(payment.bookingId);if(canonical)return canonical;}
    throw error;
  }
}

/**
 * Create a refund request only. Approval is deliberately a separate control surface.
 *
 * The previous implementation auto-approved any request made by finance or super_admin and wrote the
 * same actor into requestedBy and approvedBy. That collapses maker/checker into one click and lets a
 * privileged requester move straight to a gateway-eligible state. Role authority is still required by
 * the API boundary, but it no longer substitutes for a second human decision.
 */
export async function requestRefund(repository:PlatformRepository,payment:Payment,actor:RequestActor,amount:number,reason:string){
  // A pending request reserves refundable balance as soon as it is created. Otherwise two makers can
  // each submit an individually valid request that collectively exceeds the captured payment before a
  // checker approves either one. Rejected/cancelled/failed requests do not reserve balance.
  const existingRefunds=await repository.listRefunds(payment.id);const already=existingRefunds.filter(x=>["requested","approved","processing","completed"].includes(x.status)).reduce((sum,x)=>sum+x.amount,0);
  if(amount<=0||amount>payment.amount-already)throw Object.assign(new Error("Refund exceeds refundable balance"),{statusCode:422});
  const timestamp=now();const refund:Refund={id:id("refund"),paymentId:payment.id,bookingId:payment.bookingId,amount,reason,status:"requested",requestedBy:actor.id,createdAt:timestamp,updatedAt:timestamp};
  return repository.createRefund(refund);
}

export async function recordCash(repository:PlatformRepository,input:{booking:Booking;payment:Payment;providerId:string;collectedAt:string}){
  const collection:CashCollection={id:id("cash"),bookingId:input.booking.id,paymentId:input.payment.id,providerId:input.providerId,cityId:input.booking.cityId,amount:input.payment.amount,collectedAt:input.collectedAt,status:"collected"};return repository.createCashCollection(collection);
}

export async function reconcileCash(repository:PlatformRepository,collection:CashCollection,depositedAmount:number,note?:string){
  const status=depositedAmount===collection.amount?"reconciled":depositedAmount<collection.amount?"short":"excess";return repository.updateCashCollection(collection.id,{status,depositedAt:now(),reconciledAt:now(),reconciliationNote:note});
}

export async function createProviderEarning(repository:PlatformRepository,booking:Booking,input:{baseEarning:number;incentive?:number;deductions?:number;completedAt:string}){
  if(!booking.providerId)throw Object.assign(new Error("Booking has no assigned provider"),{statusCode:422});
  const incentive=input.incentive??0,deductions=input.deductions??0;const timestamp=now();
  const earning:ProviderEarning={id:id("earn"),bookingId:booking.id,providerId:booking.providerId,cityId:booking.cityId,serviceValue:booking.totalAmount,baseEarning:input.baseEarning,incentive,deductions,netPayable:roundMoney(input.baseEarning+incentive-deductions),eligibleAt:new Date(new Date(input.completedAt).getTime()+5*24*60*60*1000).toISOString(),status:"cooling",createdAt:timestamp,updatedAt:timestamp};
  return repository.createEarning(earning);
}

export async function createPayout(repository:PlatformRepository,input:{providerId:string;cityId:string;idempotencyKey:string;asOf?:string}){
  const existing=await repository.findPayoutByIdempotencyKey(input.idempotencyKey);if(existing)return {payout:existing,duplicatePrevented:true};
  const asOf=new Date(input.asOf??now());const earnings=(await repository.listEarnings(input.providerId)).filter(x=>x.status==="eligible"||x.status==="cooling"&&new Date(x.eligibleAt)<=asOf);
  if(!earnings.length)throw Object.assign(new Error("No eligible earnings for payout"),{statusCode:422});
  const timestamp=now();const payout:ProviderPayout={id:id("payout"),providerId:input.providerId,cityId:input.cityId,earningIds:earnings.map(x=>x.id),amount:roundMoney(earnings.reduce((sum,x)=>sum+x.netPayable,0)),gateway:"razorpayx",status:"queued",idempotencyKey:input.idempotencyKey,scheduledAt:timestamp,createdAt:timestamp,updatedAt:timestamp};
  await repository.createPayout(payout);await Promise.all(earnings.map(x=>repository.updateEarning(x.id,{status:"scheduled",payoutId:payout.id,updatedAt:timestamp})));return {payout,duplicatePrevented:false};
}
