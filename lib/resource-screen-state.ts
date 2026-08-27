/*
 * What a screen that loads one record by id should be showing.
 *
 * MEASURED in a browser: /food/manage?orderId=<unknown> drew a COMPLETE order page — "Order truth",
 * "Inventory reservation: not set", "Dispatch not dispatched" — plus a cancellation control, for an
 * order that does not exist. loadCustomerFoodOrder returns [] for an unknown id, the component stored
 * null, and every field went through String(value||"not set"), so ABSENT was drawn as a record whose
 * fields merely happen to be unset. /food/subscription-payment had the mirror failure: with no
 * renewalId, or one that matches nothing, it rendered its header and then silently nothing at all.
 *
 * Both are the audit's recurring shape — unknown or absent treated as a valid state — this time as a
 * whole screen rather than a single check.
 *
 * `loaded` is the field that does the work. Without it, "we have not asked yet" and "we asked and there
 * is nothing" are the same value, and no screen can tell a missing record from a pending one. An error
 * outranks both, so a failed request is never reported to a customer as a missing record.
 *
 * Kept in one place because two screens needed exactly this and each had invented its own answer.
 * [PTJA-P1-F35]
 */
export type ResourceScreen="no-id"|"loading"|"not-found"|"failed"|"ready";

export function resourceScreenState(input:{id:unknown;loaded:boolean;resource:unknown;error:unknown}):ResourceScreen{
  if(!String(input.id??"").trim())return "no-id";
  if(String(input.error??"").trim())return "failed";
  if(!input.loaded)return "loading";
  return input.resource?"ready":"not-found";
}
