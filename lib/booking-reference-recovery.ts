import {loadCustomerConfirmationProjection,type CustomerConfirmationProjection} from './customer-checkout-client';
export type RecoverableService='boarding'|'sitting'|'taxi';
const serviceCodes={boarding:'boarding',sitting:'pet_sitting',taxi:'pet_taxi'}as const;
export function validateRecoveredBooking(value:CustomerConfirmationProjection,bookingId:string,service:RecoverableService){
 if(!bookingId||!value||value.bookingId!==bookingId||value.serviceCode!==serviceCodes[service])throw new Error('The booking reference does not match this service. Open the correct booking from Activity.');
 if(typeof value.bookingStatus!=='string'||!value.bookingStatus.trim()||typeof value.packageName!=='string'||!value.packageName.trim()||!Number.isFinite(value.totalAmount)||value.totalAmount<0)throw new Error('The booking response is incomplete. Retry verification; do not create another booking.');
 return value;
}
/** Status read only. Ownership is enforced by the existing server checkout projection. */
export async function loadVerifiedBookingReference(bookingId:string,service:RecoverableService,signal?:AbortSignal){
 if(!bookingId.trim()||bookingId.length>160||/[\u0000-\u001f]/.test(bookingId))throw new Error('Open a valid booking reference from your Activity.');
 return validateRecoveredBooking(await loadCustomerConfirmationProjection(bookingId,signal),bookingId,service);
}
/** The same page without the saved booking reference, so a customer can start a separate booking. */
export function withoutBookingReference(href:string){const url=new URL(href);url.searchParams.delete('bookingId');return url.pathname+url.search+url.hash;}
