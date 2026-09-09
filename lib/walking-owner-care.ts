export type WalkingOwnerCare = {instructions: string; handoverPreference: "owner" | "building_staff" | "secure_key" | null};
export function normalizeWalkingOwnerCare(value: unknown): WalkingOwnerCare | null {
 if (value == null) return null;
 if (typeof value !== "object" || Array.isArray(value)) throw new Error("Walking care must be an object");
 const input = value as Record<string, unknown>;
 if (typeof input.instructions !== "string" || input.instructions.length > 2000) throw new Error("Walking instructions must be text of at most 2000 characters");
 const preference = input.handoverPreference;
 if (preference !== null && (typeof preference !== "string" || !["owner", "building_staff", "secure_key"].includes(preference))) throw new Error("Choose a valid handover preference");
 return {instructions: input.instructions.trim(), handoverPreference: preference as WalkingOwnerCare["handoverPreference"]};
}
export function walkingOwnerCareFromAssignment(value: unknown): WalkingOwnerCare | null {
 try {const assignment = typeof value === "string" ? JSON.parse(value) : value; return normalizeWalkingOwnerCare(assignment?.ownerCare);} catch {return null;}
}
