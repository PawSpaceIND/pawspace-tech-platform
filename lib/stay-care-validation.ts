import type { SittingCarePlan } from "./sitting-lifecycle";

export type RequiredStayCareField = "vet" | "emergencyContact" | "homeAccess";

/** Existing confirmation requirements, shared with the earlier Care Card step. */
export function missingStayCareFields(mode: "boarding" | "sitting", care: SittingCarePlan): RequiredStayCareField[] {
  const fields: RequiredStayCareField[] = mode === "sitting"
    ? ["vet", "emergencyContact", "homeAccess"]
    : ["vet", "emergencyContact"];
  return fields.filter(field => !care[field]?.trim());
}
