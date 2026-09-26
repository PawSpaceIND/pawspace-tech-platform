export type BoardingCustomerFinanceAction="request_cancel"|"request_date_change";
export type BoardingFinanceStaffAction="approve_cancel"|"apply_date_change"|"record_refund"|"prepare_settlement"|"reconcile";
export type BoardingFinanceMutation={bookingId:string;action:BoardingFinanceStaffAction;idempotencyKey:string;reason?:string;quoteId?:string;approvedRefundAmount?:number;refundReference?:string;paymentAdjustmentReference?:string};

type BoardingFinanceRequest={bookingId:string;action:BoardingCustomerFinanceAction;idempotencyKey:string;reason:string;requestedStart?:string;requestedEnd?:string};

async function parse(response:Response,fallback="Unable to update Boarding booking"){const payload=await response.json().catch(()=>({})) as Record<string,unknown>;if(!response.ok)throw new Error(String(payload.error||fallback));return payload.data as Record<string,unknown>;}
const post=(body:Record<string,unknown>)=>fetch("/api/boarding-finance",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});

export async function requestBoardingFinanceChange(input:BoardingFinanceRequest){return parse(await fetch("/api/boarding-finance",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)}));}
export async function loadBoardingFinanceQueue(){return parse(await fetch("/api/boarding-finance?view=queue",{cache:"no-store"}),"Unable to load the Boarding finance queue");}
export async function loadBoardingFinance(bookingId:string){return parse(await fetch(`/api/boarding-finance?bookingId=${encodeURIComponent(bookingId)}`,{cache:"no-store"}),"Unable to load Boarding finance");}
export async function updateBoardingFinance(input:BoardingFinanceMutation){return parse(await post(input),"Unable to update Boarding finance");}
// Finance workspace actions: each sends exactly the fields app/api/boarding-finance validates for that action.
export async function approveBoardingCancellation(input:{bookingId:string;requestId:string;approvedRefundAmount:number;reason:string}){return updateBoardingFinance({bookingId:input.bookingId,action:"approve_cancel",approvedRefundAmount:input.approvedRefundAmount,reason:input.reason,idempotencyKey:`boarding-finance:approve-cancel:${input.requestId}`});}
export async function recordBoardingRefund(input:{bookingId:string;refundId:string;refundReference:string}){return updateBoardingFinance({bookingId:input.bookingId,action:"record_refund",refundReference:input.refundReference,idempotencyKey:`boarding-finance:refund:${input.refundId}:${input.refundReference}`});}
export async function applyBoardingDateChange(input:{bookingId:string;requestId:string;quoteId:string;paymentAdjustmentReference?:string}){return updateBoardingFinance({bookingId:input.bookingId,action:"apply_date_change",quoteId:input.quoteId,paymentAdjustmentReference:input.paymentAdjustmentReference||undefined,idempotencyKey:`boarding-finance:date-change:${input.requestId}:${input.quoteId}`});}
export async function prepareBoardingSettlement(bookingId:string){return updateBoardingFinance({bookingId,action:"prepare_settlement",idempotencyKey:`boarding-finance:settlement:${bookingId}`});}
export async function reconcileBoardingFinance(bookingId:string){return updateBoardingFinance({bookingId,action:"reconcile",idempotencyKey:`boarding-finance:reconcile:${bookingId}:${Date.now()}`});}
export async function issueBoardingFinanceInvoice(input:{bookingId:string;reason:string}){return parse(await post({action:"issue_invoice",bookingId:input.bookingId,reason:input.reason}),"Unable to issue the Boarding invoice");}
export async function saveBoardingFinanceTaxPolicy(input:{cityId:string;taxMode:"inclusive"|"exclusive";taxRate:number;effectiveFrom:string;reason:string}){return parse(await post({action:"save_tax_policy",cityId:input.cityId,taxMode:input.taxMode,taxRate:input.taxRate,effectiveFrom:input.effectiveFrom,reason:input.reason}),"Unable to publish the Boarding tax policy");}
