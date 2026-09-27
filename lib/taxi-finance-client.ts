// @ts-expect-error Node 22 strip-types requires the explicit .ts extension at runtime.
import{taxiRequest}from"./taxi-client-request.ts";
export type TaxiFinanceAction="request_cancel"|"approve_cancel"|"record_trip_payment"|"record_refund"|"prepare_settlement"|"approve_settlement"|"reconcile";
export async function updateTaxiFinance(input:{bookingId:string;action:TaxiFinanceAction;idempotencyKey:string;reason?:string;paymentReference?:string;approvedRefundAmount?:number;refundReference?:string}){const response=await fetch("/api/taxi-finance",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});const body=await response.json() as {data?:Record<string,unknown>;error?:string};if(!response.ok||!body.data)throw new Error(body.error??"Unable to update Pet Taxi finance");return body.data}
export async function loadTaxiFinance(bookingId:string){const response=await fetch(`/api/taxi-finance?bookingId=${encodeURIComponent(bookingId)}`,{cache:"no-store"});const body=await response.json() as {data?:Record<string,unknown>;error?:string};if(!response.ok||!body.data)throw new Error(body.error??"Unable to load Pet Taxi finance");return body.data}
/**
 * The customer's cancellation. An unpaid ride hold is cancelled at once and its car and driver released
 * (status "cancelled"); a paid ride files a Finance review (status "policy_review_required"). The key is
 * stable per booking and reason, so pressing again after a lost answer replays the same result.
 */
export type TaxiCancellationResult={requestId?:string;bookingId:string;status:"cancelled"|"policy_review_required"|string;refundPolicy?:string;bookingPreserved?:boolean;capacityReleased?:boolean;duplicatePrevented?:boolean};
export async function requestTaxiCancellation(input:{bookingId:string;reason:string}){return taxiRequest<TaxiCancellationResult>("/api/taxi-finance",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({bookingId:input.bookingId,action:"request_cancel",reason:input.reason,idempotencyKey:`taxi-cancel:${input.bookingId}:${input.reason.trim().toLowerCase()}`})},{action:"cancel your ride",refused:"This ride could not be cancelled online. Please contact PawSpace support.",timeoutMs:60_000});}
