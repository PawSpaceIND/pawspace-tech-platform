import { apiSend } from "../api-fetch";
import { groomingSlotWindow, groomingSlotAvailable } from "../grooming-booking-calendar";
import { previewUatProviders, type ProviderPreview } from "../uat-scheduling-client";
import { resolveServiceCoverage, type ResolvedServiceCoverage } from "../service-zone-client";

export type V2GroomingBundle = {
  petCount: number;
  packageCode: string;
  price: number;
  currency: string;
  slotMinutes: number;
  blockingMinutes: number;
  effectiveFrom: string;
  effectiveTo: string | null;
};

export type V2GroomingPackage = {
  code: string;
  name: string;
  description: string;
  audience: "dog" | "cat" | "young";
  bundles: V2GroomingBundle[];
};

export type V2GroomingCatalogue = {
  serviceCode: "grooming";
  packages: V2GroomingPackage[];
};

export type V2GroomingQuote = {
  price: number;
  source: "pricing_control" | "fallback_default";
};

export async function loadV2GroomingCatalogue(): Promise<V2GroomingCatalogue> {
  return apiSend<V2GroomingCatalogue>(
    "/api/v2/grooming-catalogue",
    { cache: "no-store" },
    "We could not load grooming packages right now.",
  );
}

export function groomingBundleForCount(pkg: V2GroomingPackage, petCount: number) {
  return pkg.bundles.find(bundle => bundle.petCount === petCount) || null;
}

export async function resolveV2GroomingCoverage(pincode: string): Promise<ResolvedServiceCoverage> {
  return resolveServiceCoverage(pincode);
}

export async function quoteV2Grooming(input: {
  bundle: V2GroomingBundle;
  isoDate: string;
  slotIndex: number;
  cityId: string;
  zoneId: string;
}): Promise<{ quote: V2GroomingQuote; scheduledStart: string; scheduledEnd: string }> {
  if (!groomingSlotAvailable(input.isoDate, input.slotIndex, input.bundle.slotMinutes)) {
    throw new Error("Choose a future grooming slot within service hours.");
  }
  if (input.bundle.effectiveFrom > input.isoDate || (input.bundle.effectiveTo && input.bundle.effectiveTo < input.isoDate)) {
    throw new Error("This package is not published for the selected date. Refresh the care packages.");
  }
  const { start, end } = groomingSlotWindow(input.isoDate, input.slotIndex, input.bundle.slotMinutes);
  const quote = await apiSend<V2GroomingQuote>(
    "/api/live-price-quote",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        packageCode: input.bundle.packageCode,
        fallbackPrice: input.bundle.price,
        scheduledStart: start.toISOString(),
        cityId: input.cityId,
        zoneId: input.zoneId,
      }),
    },
    "We could not confirm the live grooming price.",
  );
  if (quote.source !== "pricing_control" || !Number.isFinite(quote.price) || quote.price <= 0) {
    throw new Error("A published live grooming price could not be verified. Refresh packages before continuing.");
  }
  return { quote, scheduledStart: start.toISOString(), scheduledEnd: end.toISOString() };
}

export async function previewV2Groomers(input: {
  customerId: string;
  petIds: string[];
  cityId: string;
  zoneId: string;
  scheduledStart: string;
  scheduledEnd: string;
  preferredProviderId?: string;
  serviceAddress: string;
  servicePincode: string;
}): Promise<ProviderPreview> {
  if (input.serviceAddress.trim().length < 8 || !/^[1-9][0-9]{5}$/.test(input.servicePincode)) {
    throw new Error("Verify the complete doorstep and PIN before checking groomers.");
  }
  const preview = await previewUatProviders({
    clientRequestId: `v2-grooming-preview:${crypto.randomUUID()}`,
    customerId: input.customerId,
    petIds: input.petIds,
    serviceCode: "grooming",
    cityId: input.cityId,
    zoneId: input.zoneId,
    scheduledStart: input.scheduledStart,
    scheduledEnd: input.scheduledEnd,
    preferredProviderId: input.preferredProviderId,
    serviceAddress: input.serviceAddress.trim(),
    servicePincode: input.servicePincode,
  });
  if (preview.availabilityChecked !== true || preview.reserved !== false ||
      preview.cityId !== input.cityId || preview.zoneId !== input.zoneId ||
      preview.scheduledStart !== input.scheduledStart || preview.scheduledEnd !== input.scheduledEnd) {
    throw new Error("Groomer availability does not match this doorstep and time. Check availability again.");
  }
  return preview;
}
