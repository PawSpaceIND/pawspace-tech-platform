import { enqueueCommunication } from "../communication-engine";
import { routeHumanEscalation } from "../executive/human-escalation-router";

type Db = D1Database;
type Row = Record<string, unknown>;
const text = (value: unknown) => String(value ?? "").trim();

export type OpsRecoverySignal = {
  bookingId: string;
  signal: "delay" | "provider_no_show" | "provider_unavailable";
  reason: string;
  detectedAt?: number;
};

export type CanonicalProviderRecoveryTool = (input: {
  bookingId: string;
  cityId: string;
  zoneId: string;
  serviceCode: string;
  failedProviderId: string;
  reason: string;
  idempotencyKey: string;
  actorId: string;
}) => Promise<{ status: string; replacementProviderId?: string | null; detail?: Record<string, unknown> }>;

export async function runOpsManagerAgent(db: Db, input: OpsRecoverySignal, tools: { providerRecover: CanonicalProviderRecoveryTool }) {
  const booking = await db.prepare("SELECT id,customer_id,provider_id,service_code,city_id,zone_id,status FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Row>();
  if (!booking) throw new Error("Canonical booking not found");
  const serviceCode = text(booking.service_code), cityId = text(booking.city_id), zoneId = text(booking.zone_id), providerId = text(booking.provider_id);
  if (!providerId || !serviceCode || !cityId || !zoneId) throw new Error("Booking is missing canonical recovery coordinates");

  const injury = /injur|bite|bleed|accident|medical emergency/i.test(input.reason);
  if (injury) {
    const escalation = await routeHumanEscalation(db, { kind: "safety_injury", sourceAgent: "ops-manager-agent", summary: input.reason, bookingId: input.bookingId, cityId, zoneId });
    return { status: "human_escalation" as const, ...escalation };
  }

  const idempotencyKey = `agent:ops:provider-recover:${input.bookingId}:${input.signal}:${Math.floor((input.detectedAt ?? Date.now()) / 60_000)}`;
  const recovered = await tools.providerRecover({ bookingId: input.bookingId, cityId, zoneId, serviceCode, failedProviderId: providerId, reason: input.reason, idempotencyKey, actorId: "system:ops-manager-agent" });

  const customerId = text(booking.customer_id);
  if (customerId) {
    await enqueueCommunication(db, {
      customerId, cityId, channel: "whatsapp", purpose: "service_recovery",
      idempotencyKey: `${idempotencyKey}:customer-update`, templateKey: "provider_recovery_update", bookingId: input.bookingId,
      createdBy: "system:ops-manager-agent",
      payload: { bookingId: input.bookingId, recoveryStatus: recovered.status, replacementProviderId: recovered.replacementProviderId ?? null, reasonCode: input.signal },
    });
  }
  return { status: "recovery_routed" as const, canonicalMutationTool: "provider.recover" as const, recovery: recovered };
}
