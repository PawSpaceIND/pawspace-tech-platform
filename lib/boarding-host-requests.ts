/**
 * The Boarding Care Card's extras - Pickup & drop, Three walks, Medication support, 1-hour play time, Grooming add-on,
 * Training add-on - are requests to the host, not priced add-ons: canonical bookings refuse add-ons outside Grooming,
 * the governed quote carries no amount for them, and no price has been set for any of them. They reach the host as a
 * labelled line of the care plan (lib/boarding-customer-care.ts boardingCareDraft).
 *
 * Round-2 staging (BRD-01): the Care Card said only "Subject to host agreement", the Review listed them under
 * "Care benefits" and the bill showed no line for them, so a customer could read them as included in the price.
 * Everywhere the customer sees them - Care Card, Review, the payment step and the manage page - says the same thing:
 * they are requests, not part of the price, and the host confirms any extra charge before it applies. Browser-safe.
 */
// @ts-expect-error Node 22 strip-types requires the explicit .ts extension at runtime.
import {boardingProviderExtras} from "./boarding-provider-projection.ts";

export const HOST_REQUESTS_TITLE="Requests for your host";
export const HOST_REQUESTS_NOT_INCLUDED="Not included in the price";
/** Workbook row 54 asked for chargeable add-ons with real prices: no priced Boarding add-on catalogue exists, so none is listed. */
export const ADD_ON_PRICE_NOTE="No priced Boarding add-ons are published yet, so none are listed here. Anything chargeable is a request your host confirms, with its price, before it applies.";
export const HOST_REQUESTS_NOTE="These are requests to your host, not part of your booking price. Your host confirms whether they can help, and any extra charge, before it applies. Nothing extra is charged now.";

/** The Review row's value. */
export function hostRequestsReviewValue(requests:string[]){
 return requests.length?`${requests.join(" · ")} - requests, not included in this price`:"None";
}

/** The line under a bill or a payment that the requests are not in it, or null when there are none. */
export function hostRequestsExcludedNote(requests:string[],what="this total"){
 return requests.length?`Not included in ${what}: ${requests.join(", ")}. Your host confirms any extra charge before it applies.`:null;
}

/** The requests saved on a stay's care plan (the line boardingCareDraft writes), for the manage page. */
export function hostRequestsFromCarePlan(plan:unknown):string[]{
 const specialInstructions=plan&&typeof plan==="object"?(plan as {specialInstructions?:unknown}).specialInstructions:undefined;
 return boardingProviderExtras(specialInstructions);
}
