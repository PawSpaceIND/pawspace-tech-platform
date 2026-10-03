/**
 * The Payments-tab card for a booking's reschedule requests, in words that match the number shown.
 *
 * Every request the booking holds is counted, whatever its status. The card names requests, not
 * payments, because a request's status alone is not proof of a captured payment (a late capture can
 * follow a lapsed hold, and a failed move may or may not have been paid). The latest request's own
 * status wording sits beside the number and stays the only place payment state is described.
 */
export type RescheduleRequestCard = { label: "Reschedule requests"; count: number; emptyCopy: "No reschedule request" };

export function rescheduleRequestCard(requests: ReadonlyArray<unknown> | null | undefined): RescheduleRequestCard {
  return { label: "Reschedule requests", count: Array.isArray(requests) ? requests.length : 0, emptyCopy: "No reschedule request" };
}
