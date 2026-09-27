import type { ProviderPreview } from "../uat-scheduling-client";

export const GROOMING_STEPS = [
  { number: 1, id: "v2-grooming-pets", label: "Pets" },
  { number: 2, id: "v2-grooming-package", label: "Package" },
  { number: 3, id: "v2-grooming-address", label: "Address" },
  { number: 4, id: "v2-grooming-time", label: "Time & review" },
] as const;
export type GroomingStep = typeof GROOMING_STEPS[number]["number"];

type StepContext = {
  petCount: number;
  selectionIssue: boolean;
  hasPackage: boolean;
  packageIssue: boolean;
  addressVerified: boolean;
  reserving: boolean;
};

/** Navigation never submits, reboots or edits the draft. Checkout keeps its own authoritative guards. */
export function groomingStepAccess(context: StepContext): Record<GroomingStep, string | null> {
  if (context.reserving) return { 1: "Your booking is being reserved.", 2: "Your booking is being reserved.", 3: "Your booking is being reserved.", 4: "Your booking is being reserved." };
  const pets = context.petCount > 0 && !context.selectionIssue;
  const care = pets && context.hasPackage && !context.packageIssue;
  return {
    1: null,
    2: pets ? null : "Choose a valid pet selection first.",
    3: care ? null : "Choose an eligible pet and package first.",
    4: !care ? "Choose an eligible pet and package first." : context.addressVerified ? null : "Check your service address first.",
  };
}

/** Use only the server's already-filtered shortlist, in its ranked order. This does not reserve work. */
export function suggestedGroomerId(preview: ProviderPreview): string {
  return preview.availabilityChecked === true && preview.reserved === false ? preview.providers[0]?.id || "" : "";
}
