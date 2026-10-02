import type { CustomerAccountRecord } from "../customer-account";
import { serviceAddressConflict } from "../service-address-consistency";
import { v2GroomingSelectionIssue, v2GroomingServiceDate, v2YoungPackageIssue } from "./grooming-selection";
import { stableBookingInputKey } from "../booking-input-fingerprint";
import { groomingAddOnsForSpecies } from "../grooming-add-ons";
import { createCanonicalLifecycle, type CanonicalLifecycleResult } from "../canonical-lifecycle-client";
import { apiSend } from "../api-fetch";
import { quoteGovernedCoupon } from "../coupon-governance-client";
import { groomingBasketTotal, groomingCouponPayable } from "./grooming-money";
import { CustomerCheckoutController, checkoutReturnUrl, type CustomerConfirmationProjection, type CheckoutState } from "../customer-checkout-client";
import { openMobileRazorpayCheckout } from "../mobile/razorpay";
import { reserveUatSchedule, type ProviderPreview } from "../uat-scheduling-client";
import type { V2GroomingBundle, V2GroomingPackage, V2GroomingQuote } from "./grooming-client";

export type V2GroomingPaymentChoice = "prepaid" | "pay_after_service";

export type V2GroomingCheckoutInput = {
  account: CustomerAccountRecord;
  selectedPets: CustomerAccountRecord["pets"];
  pkg: V2GroomingPackage;
  bundle: V2GroomingBundle;
  quote: V2GroomingQuote;
  provider: ProviderPreview["providers"][number];
  /** Omitted by older callers: preserve their exact-provider behavior and retry key. */
  providerSelection?: "auto" | "specific";
  /** V1 parity: pay now by Razorpay/UPI, or settle after the service by secure link/UPI or cash. */
  paymentMode?: V2GroomingPaymentChoice;
  address: string;
  pincode: string;
  cityName?: string;
  cityId: string;
  zoneId: string;
  scheduledStart: string;
  scheduledEnd: string;
  /** Keep this doorstep in the customer's saved places (only when they ticked "Save this address"). */
  saveAddress?: boolean;
  /** Owner decision (H4): V2 offers the in-app extras. Add-on labels come from the governed catalogue. */
  addOns?: string[];
  comfort?: "friendly" | "anxious" | "aggressive";
  specialInstructions?: string;
  /** A governed coupon quote for this exact package and live price; the booking re-checks and consumes it. */
  coupon?: { quoteId: string; code: string; discount: number };
};

/** Package quote plus add-ons: the server governs the package price and adds the catalogue add-on prices. */
export function v2GroomingTotal(input: Pick<V2GroomingCheckoutInput, "quote" | "addOns" | "selectedPets">) {
  const species = String(input.selectedPets[0]?.species || "").toLowerCase();
  const available = groomingAddOnsForSpecies(species);
  const total = groomingBasketTotal(input.quote.price, ...(input.addOns ?? []).map(label => available.find(item => item.label === label)?.price ?? 0));
  if (total === null) throw new Error("A valid live price is required before booking.");
  return total;
}

export type V2GroomingBooking = CanonicalLifecycleResult & {
  idempotencyKey: string;
  providerName: string;
};

export async function v2GroomingIdempotencyKey(input: V2GroomingCheckoutInput) {
  const values = [
    input.account.customerId,
    input.bundle.packageCode,
    input.scheduledStart,
    input.scheduledEnd,
    input.cityId,
    input.zoneId,
    input.address.trim(),
    input.pincode,
    String(input.quote.price),
    ...(input.addOns ?? []).slice().sort(),
    input.comfort ?? "",
    (input.specialInstructions ?? "").trim(),
    input.providerSelection === "auto" ? "pawspace:automatic-choice" : input.provider.id,
    `payment:${input.paymentMode ?? "prepaid"}`,
    ...input.selectedPets.map(pet => pet.id).sort(),
    // The code, not its quote: a retry re-quotes the coupon but must keep the same booking.
    ...(input.coupon ? [`coupon:${input.coupon.code}`] : []),
    ...(input.pkg.subscription ? [`subscription:${input.pkg.subscription.code}:v${input.pkg.subscription.version}`] : []),
  ];
  // Retain the existing deterministic fingerprint, with SHA-256 to avoid 32-bit collisions.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(values)));
  const hash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
  return `v2-groom-${stableBookingInputKey(values)}-${hash}`;
}

export async function createV2GroomingBooking(
  submitted: V2GroomingCheckoutInput,
  onCreated?: (booking: V2GroomingBooking) => void,
): Promise<V2GroomingBooking> {
  // An in-flight booking uses the confirmed snapshot, never mutable form references.
  const input = structuredClone(submitted);
  const serviceDate = v2GroomingServiceDate(input.scheduledStart);
  const selectionIssue = v2GroomingSelectionIssue(input.selectedPets, input.pkg.audience, serviceDate);
  if (selectionIssue) throw new Error(selectionIssue);
  const addressIssue = serviceAddressConflict(input.address, input.cityName || (input.cityId === "blr" ? "Bengaluru" : input.cityId), input.pincode);
  if (addressIssue) throw new Error(addressIssue);
  if (input.selectedPets.some(pet => !String(pet.sourceId || pet.id).trim())) throw new Error("Every selected pet needs a canonical source identity.");
  if (!input.address.trim() || !/^\d{6}$/.test(input.pincode)) throw new Error("Verify a complete service address before booking.");
  if (!Number.isFinite(input.quote.price) || input.quote.price <= 0) throw new Error("A valid live price is required before booking.");

  if (input.quote.source !== "pricing_control" && !(input.pkg.subscription && input.quote.source === "subscription_control" && input.quote.price === input.pkg.subscription.price && input.quote.subscriptionVersion === input.pkg.subscription.version)) throw new Error("Only a published live price can enter checkout.");
  const allowedAddOns = groomingAddOnsForSpecies(String(input.selectedPets[0]?.species || "").toLowerCase()).map(item => item.label);
  if ((input.addOns ?? []).some(label => !allowedAddOns.includes(label)) || new Set(input.addOns ?? []).size !== (input.addOns ?? []).length) throw new Error("Choose add-ons available for this pet.");
  if ((input.specialInstructions ?? "").length > 300) throw new Error("Keep groomer notes under 300 characters.");
  if (input.coupon && (!input.coupon.quoteId || !input.coupon.code)) throw new Error("Reapply the coupon before booking.");
  // Reject locally invalid bookings before requesting a persisted coupon quote.
  if (input.selectedPets.length > 4 || new Set(input.selectedPets.map(pet => pet.id)).size !== input.selectedPets.length ||
      input.bundle.petCount !== input.selectedPets.length || !input.pkg.bundles.some(bundle => bundle.packageCode === input.bundle.packageCode)) {
    throw new Error("The published package must match the selected pets.");
  }
  if (input.selectedPets.some(pet => !input.account.pets.some(owned => owned.id === pet.id))) throw new Error("Use pets from your signed-in account.");
  const start = Date.parse(input.scheduledStart), end = Date.parse(input.scheduledEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= Date.now() || end <= start ||
      end - start !== input.bundle.slotMinutes * 60_000) throw new Error("Refresh the exact grooming time before booking.");
  if (input.pkg.audience === "young" && serviceDate) {
    const youngIssue = v2YoungPackageIssue(input.selectedPets, serviceDate);
    if (youngIssue) throw new Error(youngIssue.message);
  }

  // The shown quote may have expired (15 minutes) or been used up since it was applied. Re-quote it now,
  // before anything is reserved, and book with the server's fresh discount and quote - never the
  // client's copy - so a coupon that no longer qualifies is refused without holding the slot.
  const basketTotal = v2GroomingTotal(input);
  const paymentMode = input.paymentMode ?? "prepaid";
  if (paymentMode !== "prepaid" && paymentMode !== "pay_after_service") throw new Error("Choose Pay now or Pay after service for Grooming.");
  if(input.pkg.subscription && paymentMode!=="prepaid") throw new Error("Subscriptions require the existing prepaid purchase flow.");
  const couponPaymentMode = paymentMode === "prepaid" ? "full" : "after_service";
  const idempotencyKey = await v2GroomingIdempotencyKey(input);
  const coupon = input.coupon ? await quoteGovernedCoupon({ code: input.coupon.code, customerId: input.account.customerId, serviceCode: "grooming", cityId: input.cityId, channel: "website", packageCode: input.bundle.packageCode, orderValue: basketTotal, paymentMode: couponPaymentMode, isSubscription: Boolean(input.pkg.subscription), bookingKey: idempotencyKey }) : null;
  if (coupon && (!coupon.valid || !coupon.quoteId || !coupon.code)) throw new Error(`${(coupon.error || "This coupon no longer applies to this booking").replace(/\.?$/, ".")} Remove or reapply the coupon.`);
  const payable = coupon ? groomingCouponPayable(basketTotal, coupon) : basketTotal;
  const discount = coupon ? coupon.discount : 0;
  const addOns = input.addOns ?? [], requirements = [
    ...(input.comfort ? [`grooming_safety:${input.comfort}`] : []),
    ...((input.specialInstructions ?? "").trim() ? [`grooming_special:${(input.specialInstructions ?? "").trim()}`] : []),
  ];

  const decision = await reserveUatSchedule({
    clientRequestId: idempotencyKey,
    customerId: input.account.customerId,
    petIds: input.selectedPets.map(pet => pet.id),
    serviceCode: "grooming",
    cityId: input.cityId,
    zoneId: input.zoneId,
    serviceAddress: input.address.trim(),
    servicePincode: input.pincode,
    scheduledStart: input.scheduledStart,
    scheduledEnd: input.scheduledEnd,
    providerSelection: input.providerSelection ?? "specific",
    ...(input.providerSelection === "auto" ? {} : { preferredProviderId: input.provider.id }),
  });
  if (!decision.provider || decision.groupId !== idempotencyKey || (input.providerSelection !== "auto" && decision.provider.id !== input.provider.id)) throw new Error("The selected groomer changed before reservation. Refresh availability and choose again.");

  const canonical = await createCanonicalLifecycle({
    idempotencyKey,
    scheduleGroupId: decision.groupId,
    customer: {
      id: input.account.customerId,
      name: input.account.name,
      primaryPhone: input.account.primaryPhone,
      secondaryPhone: input.account.secondaryPhone || undefined,
      email: input.account.email || undefined,
    },
    pets: input.selectedPets.map(pet => ({
      sourceId: String(pet.sourceId || pet.id),
      name: pet.name,
      species: pet.species === "cat" ? "cat" : pet.species === "dog" ? "dog" : "other",
      breed: pet.breed || undefined,
      vaccinationStatus: pet.vaccinationStatus,
    })),
    cityId: input.cityId,
    zoneId: input.zoneId,
    serviceCode: "grooming",
    // The server governs packages by base code and prices 2-4 pets from the matching
    // `<code>__<n>_pets` Pricing Control row itself; it has no catalogue entry for bundle codes.
    packageCode: input.pkg.code,
    packageName: input.pkg.name,
    scheduledStart: input.scheduledStart,
    scheduledEnd: input.scheduledEnd,
    provider: decision.provider,
    totalAmount: payable,
    amountDueNow: paymentMode === "prepaid" ? payable : 0,
    payment: {
      method: paymentMode === "prepaid" ? "upi" : "cash",
      mode: paymentMode,
      status: "created",
      detail: paymentMode === "prepaid"
        ? "PawSpace V2 secure Razorpay sandbox checkout; capture requires verified gateway evidence"
        : "Pay after service; settle by governed Razorpay/UPI request or cash collection",
    },
    // Same fields the in-app flow sends: add-ons are priced by the server; notes reach the groomer's job card;
    // a coupon is re-checked and consumed by the booking.
    pricing: { ...(coupon ? { discount, couponCode: coupon.code, couponQuoteId: coupon.quoteId } : { discount: 0 }), ...(addOns.length ? { addOns } : {}), ...(requirements.length ? { requirements } : {}) },
  });
  if (!canonical.bookingId || canonical.customerId !== input.account.customerId || canonical.scheduleGroupId !== decision.groupId) {
    throw new Error("The booking could not be matched to your account and reservation.");
  }
  const booking = { ...canonical, idempotencyKey, providerName: decision.provider.name };
  // Publish durable identity BEFORE another network step can fail. UI freezes and retries this ID.
  onCreated?.(booking);
  // A confirmed PREPAID replay has already crossed this boundary; never rewrite its doorstep. A new
  // pay-after-service booking is confirmed immediately, so it still needs the one verified doorstep write.
  if (canonical.status !== "payment_pending" && paymentMode === "prepaid") return booking;
  await saveV2GroomingDoorstep(booking.bookingId, input.account.customerId, input.address, input.pincode, input.saveAddress === true);
  return booking; // replays read the same durable booking; no gateway payment is started here
}

export async function saveV2GroomingDoorstep(bookingId: string, customerId: string, address: string, pincode: string, saveAddress = false) {
  const result = await apiSend<{ bookingId: string; addressSaved: boolean; coordinatesSaved: boolean }>(
    "/api/grooming-service-location",
    { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookingId, customerId, address: address.trim(), pincode, saveAddress }) },
    "Your booking exists, but its doorstep needs verification before payment. Retry the address on this booking.",
  );
  if (result.bookingId !== bookingId || result.addressSaved !== true || result.coordinatesSaved !== true) {
    throw new Error("The booking doorstep was not verified. Do not start payment yet.");
  }
}

export type V2GroomingCheckoutReadiness = {
  bookingId: string; customerId: string; bookingStatus: string; paymentStatus: string; locationReady: boolean;
  confirmation: CustomerConfirmationProjection;
};
export async function loadV2GroomingCheckoutReadiness(bookingId: string) {
  const result = await apiSend<V2GroomingCheckoutReadiness>(
    `/api/v2/grooming-checkout?bookingId=${encodeURIComponent(bookingId)}`, { cache: "no-store" },
  );
  if (result.bookingId !== bookingId || !result.customerId || typeof result.locationReady !== "boolean" || result.confirmation?.bookingId !== bookingId) {
    throw new Error("The booking recovery record could not be verified.");
  }
  return result;
}

export { isV2GroomingConfirmationReady } from "./grooming-confirmation-contract";

export type { CustomerConfirmationProjection };

export function v2GroomingCheckoutReturnUrl(bookingId: string, origin?: string) {
  const shared = checkoutReturnUrl(bookingId, origin);
  if (!shared) return undefined;
  const url = new URL(shared); url.pathname = "/api/v2/grooming-checkout-return";
  return url.toString();
}

export function createV2GroomingCheckoutController(bookingId: string, publish: (state: CheckoutState) => void) {
  return new CustomerCheckoutController(bookingId, publish, {
    fetch: (...args) => fetch(...args),
    open: (options, env) => openMobileRazorpayCheckout({ ...options, callbackUrl: v2GroomingCheckoutReturnUrl(bookingId) }, env),
  });
}

export type { CheckoutState };
