/**
 * Identifier minting, in one place.
 *
 * Prefixed ids (`cus_`, `apt_`, `loc_`) are worth the few extra bytes: an id in a log line, a
 * support ticket or a webhook payload says what it refers to without a lookup, and an id passed to
 * the wrong parameter is visible at a glance rather than at 3am.
 *
 * `crypto.randomUUID` is a global in Node 18+, Cloudflare Workers and browsers, but it is not in
 * the ES lib TypeScript ships. Declaring the one member used here keeps the core off the DOM lib,
 * which would otherwise bring `window`, `document` and a hundred other things that must not be
 * reachable from server code.
 */

declare const crypto: { randomUUID(): string };

export type IdPrefix =
  | "ten" // tenant
  | "idn" // identity
  | "brd" // brand
  | "loc" // location
  | "stf" // staff
  | "res" // resource
  | "svc" // service
  | "cus" // customer
  | "apt" // appointment
  | "aud"; // audit entry

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
