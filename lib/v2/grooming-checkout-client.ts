import type { CustomerAccountRecord } from "../customer-account";
import { stableBookingInputKey } from "../booking-input-fingerprint";
import { createCanonicalLifecycle, type CanonicalLifecycleResult } from "../canonical-lifecycle-client";
import { CustomerCheckoutController, type CheckoutState } from "../customer-checkout-client";
import { reserveUatSchedule, type ProviderPreview } from "../uat-scheduling-client";
import type { V2GroomingBundle, V2GroomingPackage, V2GroomingQuote } from "./grooming-client";

export type V2GroomingCheckoutInput = {
  account: CustomerAccountRecord;
  selectedPets: CustomerAccountRecord["pets"];
  pkg: V2GroomingPackage;
  bundle: V2GroomingBundle;
  quote: V2GroomingQuote;
  provider: ProviderPreview["providers"][number];
  address: string;
  pincode: string;
  cityId: string;
  zoneId: string;
  scheduledStart: string;
  scheduledEnd: string;
};

export type V2GroomingBooking = CanonicalLifecycleResult & {
  idempotencyKey: string;
  providerName: string;
};

export function v2GroomingIdempotencyKey(input: V2GroomingCheckoutInput) {
  return `v2-groom-${input.account.customerId}-${stableBookingInputKey([
    input.account.customerId,
    input.bundle.packageCode,
    input.scheduledStart,
    input.scheduledEnd,
    input.zoneId,
    input.address.trim(),
    input.pincode,
    String(input.quote.price),
    input.provider.id,
    ...input.selectedPets.map(pet => pet.id).sort(),
  ])}`;
}

export async function createV2GroomingBooking(input: V2GroomingCheckoutInput): Promise<V2GroomingBooking> {
  if (!input.selectedPets.length) throw new Error("Choose at least one pet before booking.");
  if (input.selectedPets.some(pet => !String(pet.sourceId || pet.id).trim())) throw new Error("Every selected pet needs a canonical source identity.");
  if (!input.address.trim() || !/^\d{6}$/.test(input.pincode)) throw new Error("Verify a complete service address before booking.");
  if (!Number.isFinite(input.quote.price) || input.quote.price <= 0) throw new Error("A valid live price is required before booking.");

  const idempotencyKey = v2GroomingIdempotencyKey(input);
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
    preferredProviderId: input.provider.id,
  });
  if (decision.provider.id !== input.provider.id) throw new Error("The selected groomer changed before reservation. Refresh availability and choose again.");

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
    packageCode: input.bundle.packageCode,
    packageName: input.pkg.name,
    scheduledStart: input.scheduledStart,
    scheduledEnd: input.scheduledEnd,
    provider: decision.provider,
    totalAmount: input.quote.price,
    amountDueNow: input.quote.price,
    payment: {
      method: "upi",
      mode: "prepaid",
      status: "created",
      detail: "PawSpace V2 secure Razorpay sandbox checkout; capture requires verified gateway evidence",
    },
    pricing: { discount: 0 },
  });
  if (canonical.status !== "payment_pending") throw new Error("The booking did not enter the required payment-pending state.");
  return { ...canonical, idempotencyKey, providerName: decision.provider.name };
}

export function createV2GroomingCheckoutController(bookingId: string, publish: (state: CheckoutState) => void) {
  return new CustomerCheckoutController(bookingId, publish);
}

export type { CheckoutState };
