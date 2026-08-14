// Finding #188: the single source of the customer's journey location.
//
// Every service flow (grooming, training, boarding/sitting, walking, taxi, food) used to bake the
// literal Bengaluru city/zone ("blr"/"blr-east") into its scheduling, booking and commercial-quote
// calls, so a Chennai customer could never be scheduled/booked in their own city. The location now
// comes from the customer's resolved address/pincode (via /api/service-zone) and is threaded from the
// mobile-app shell into every flow. There is NO silent Bengaluru fallback: a flow must be given a
// resolved location before it can schedule or book.
//
// cityId is derived from the resolved zone id ("blr-east" -> "blr", "maa-central" -> "maa"); zoneId is
// the resolved zone id itself. This mirrors how the scheduling/booking APIs key city and zone.
export type ResolvedLocation = { cityId: string; zoneId: string; city: string; area?: string; pincode?: string };

type ResolvedZone = { zone: { zoneId: string }; assignment: { pincode?: string; zoneId: string; city: string; area?: string } };

export function resolvedLocationFromZone(result: ResolvedZone): ResolvedLocation {
  const zoneId = result.zone.zoneId;
  return { cityId: zoneId.split("-")[0], zoneId, city: result.assignment.city, area: result.assignment.area, pincode: result.assignment.pincode };
}
