import { apiSend } from "../api-fetch";
import { groomingSlotWindow } from "../grooming-booking-calendar";
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
}): Promise<ProviderPreview> {
  return previewUatProviders({
    clientRequestId: `v2-grooming-preview:${crypto.randomUUID()}`,
    customerId: input.customerId,
    petIds: input.petIds,
    serviceCode: "grooming",
    cityId: input.cityId,
    zoneId: input.zoneId,
    scheduledStart: input.scheduledStart,
    scheduledEnd: input.scheduledEnd,
    preferredProviderId: input.preferredProviderId,
  });
}
