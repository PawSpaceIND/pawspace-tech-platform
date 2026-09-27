import { trainingBookingWhatsAppUrl } from "./training-booking-link";

/**
 * The booking link sales share with a Boarding or Pet Sitting lead, on the Training pattern (founder decision
 * 26 Sep 2026). Staff cannot book a stay in the console: "Book this customer →" opens /assisted-booking, which books
 * Grooming orders and Pet Taxi rides only. So from there staff copy the customer's booking link, or open their own
 * WhatsApp with it, and the customer chooses dates and pays in the app. PawSpace sends nothing itself.
 *
 * Why the booking converts the lead: the customer signs in with the number the lead was captured with; sign-in
 * resolves that number, in any written form, to the lead's canonical customer (lib/customer-otp.ts; a staff lead
 * gets that customer when it is added, lib/lead-customer-identity.ts); the booking is created on that customer and
 * linked to its open lead for the same service (lib/lead-conversion-attribution.ts); the lead converts when the
 * payment is captured.
 */
export const STAY_BOOKING_LINKS = [
  { service: "boarding", label: "Boarding", path: "/v2/boarding" },
  { service: "pet_sitting", label: "Pet Sitting", path: "/v2/sitting" },
] as const;
export type StayBookingService = (typeof STAY_BOOKING_LINKS)[number]["service"];

export function stayBookingLinkMessage(service: StayBookingService, name: string, origin: string) {
  const link = STAY_BOOKING_LINKS.find((item) => item.service === service) ?? STAY_BOOKING_LINKS[0];
  const first = String(name || "").trim().split(/\s+/)[0] || "there";
  return `Hi ${first}, here is your PawSpace ${link.label} booking link: ${String(origin).replace(/\/+$/, "")}${link.path}?source=crm\nSign in with the mobile number you gave us, choose your dates and pay to confirm your booking.`;
}

/** A wa.me link for a full Indian mobile, or null (a masked number, as staff screens show it, gets none). */
export const stayBookingWhatsAppUrl = trainingBookingWhatsAppUrl;
