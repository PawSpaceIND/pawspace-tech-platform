/*
 * Which Pet Taxi booking channels exist, and what each one must prove before a ride is booked.
 *
 * app/api/taxi-ride-bookings branches on `channel` to decide which authorization runs, so an
 * UNRECOGNISED channel ran none of them: `customer_app` and `boarding_cross_sell` require customer
 * ownership, `assisted_staff` requires consent evidence, and anything else fell through both
 * branches and booked. A caller holding scheduling.book could book a ride for any customer id by
 * sending a channel nobody had written a branch for.
 *
 * The union on the route's Input type is compile-time only — the body arrives through
 * request.json() — so the runtime allowlist has to exist separately, and it lives here rather than
 * in the route so a test can execute this decision instead of reading the route as text.
 *
 * `requires` is the point: an entry with nothing to prove would be the original bug wearing a
 * different hat, accepted by the allowlist and then checked by nobody.
 */
export const TAXI_RIDE_CHANNEL_REQUIREMENTS = {
  customer_app: "customer_ownership",
  boarding_cross_sell: "customer_ownership",
  assisted_staff: "assisted_consent",
} as const;

export type TaxiRideChannel = keyof typeof TAXI_RIDE_CHANNEL_REQUIREMENTS;

export const TAXI_RIDE_CHANNELS: ReadonlyArray<string> = Object.keys(TAXI_RIDE_CHANNEL_REQUIREMENTS);

/** True only for a channel this module can name a requirement for. Unknown fails closed. */
export function isTaxiRideChannel(channel: unknown): channel is TaxiRideChannel {
  return typeof channel === "string" && Object.hasOwn(TAXI_RIDE_CHANNEL_REQUIREMENTS, channel);
}

/** What the caller must prove for this channel, or null if the channel is not recognised at all. */
export function taxiRideChannelRequirement(channel: unknown) {
  return isTaxiRideChannel(channel) ? TAXI_RIDE_CHANNEL_REQUIREMENTS[channel] : null;
}
