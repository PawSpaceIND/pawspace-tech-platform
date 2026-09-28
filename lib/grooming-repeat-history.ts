import { resolveAssignmentPolicy, type AssignmentPolicyConfig } from "./provider-assignment-policy";
import type { ScheduleRequest } from "../backend/src/scheduling";

type HistoryContext = {
  customerId: string; cityId?: string; petIds: string[]; serviceCode: string;
  scheduledStart: string; providerSelection?: string; preferredProviderId?: string;
};
type HistoryRanking = Pick<ScheduleRequest, "repeatProviderId" | "rankingWeights">;

/** The caller must prove customer/pet ownership first. History is affinity, never saved consent. */
export async function previousCompletedGroomer(
  db: D1Database, context: Pick<HistoryContext, "customerId" | "cityId" | "petIds">,
  asOf = new Date(),
): Promise<string | undefined> {
  const { customerId, cityId, petIds } = context;
  if (!customerId?.trim() || !cityId?.trim() || !Array.isArray(petIds) || !petIds.length ||
      petIds.some(id => typeof id !== "string" || !id.trim()) || new Set(petIds).size !== petIds.length ||
      !Number.isFinite(asOf.getTime())) throw new Error("Valid customer, city, pets and history time are required.");
  // A cold database has no history. Do not create booking tables from the preview path.
  // Query errors are deliberately propagated; an outage is not evidence of a first-time customer.
  const exists = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .bind("canonical_bookings").first<{ name: string }>();
  if (!exists) return undefined;
  const row = await db.prepare(`SELECT b.provider_id FROM canonical_bookings b
    WHERE b.customer_id=? AND b.city_id=? AND b.service_code='grooming' AND b.status='completed'
      AND b.provider_id IS NOT NULL AND TRIM(b.provider_id)!=''
      AND julianday(b.scheduled_end)<=julianday(?)
      AND json_type(CASE WHEN json_valid(b.pet_ids_json) THEN b.pet_ids_json ELSE '[]' END)='array'
      AND NOT EXISTS (SELECT 1 FROM json_each(?) wanted WHERE NOT EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_valid(b.pet_ids_json) THEN b.pet_ids_json ELSE '[]' END) seen
        WHERE seen.type='text' AND seen.value=wanted.value))
    ORDER BY julianday(b.scheduled_end) DESC,b.created_at DESC,b.id DESC LIMIT 1`)
    .bind(customerId, cityId, asOf.toISOString(), JSON.stringify(petIds)).first<{ provider_id: string }>();
  return row?.provider_id || undefined;
}

/** Supply only server-derived affinity and existing policy weights to the unchanged scheduler. */
export async function groomingHistoryRanking(db: D1Database, context: HistoryContext,
  config?: AssignmentPolicyConfig): Promise<HistoryRanking> {
  if (context.serviceCode !== "grooming" || context.providerSelection === "specific" || context.preferredProviderId) return {};
  if (config && (config.preferredProviderMode === "disabled" || config.repeatProviderBonus <= 0)) return {};
  const repeatProviderId = await previousCompletedGroomer(db, context);
  if (!repeatProviderId) return {};
  const policy = config ?? (await resolveAssignmentPolicy(db, "grooming", String(context.cityId), new Date(context.scheduledStart), { readOnly: true })).config;
  if (policy.preferredProviderMode === "disabled" || policy.repeatProviderBonus <= 0) return {};
  return { repeatProviderId, rankingWeights: {
    qualityWeight: policy.qualityWeight, fullTimeBonus: policy.fullTimeBonus,
    preferredProviderBonus: policy.preferredProviderBonus, repeatProviderBonus: policy.repeatProviderBonus,
    distanceWeight: policy.distanceWeight, residualCapacityWeight: policy.residualCapacityWeight,
    workloadPenalty: policy.workloadPenalty,
  } };
}
