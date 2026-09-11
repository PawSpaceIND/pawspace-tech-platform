import { enqueueCommunication } from "../communication-engine";
import { ensureOutboundOrchestratorTables } from "../outbound-schema";

type Db = D1Database;
type Row = Record<string, unknown>;
const text = (value: unknown) => String(value ?? "").trim();
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;

async function marketingConsentGranted(db: Db, customerId: string) {
  const pref = await db.prepare("SELECT marketing FROM communication_preferences WHERE customer_id=?").bind(customerId).first<Row>().catch(() => null);
  if (pref && pref.marketing != null) return Number(pref.marketing) === 1;
  const customer = await db.prepare("SELECT consent_json FROM canonical_customers WHERE id=?").bind(customerId).first<Row>().catch(() => null);
  try { return Boolean(JSON.parse(text(customer?.consent_json) || "{}").marketing); } catch { return false; }
}

export type LifecycleCopyGenerator = (input: { customerName: string; serviceCode: string; petNames: string[]; daysSinceService: number }) => Promise<string> | string;

export async function runMarketingManagerAgent(db: Db, input: { asOf?: number; limit?: number; copyGenerator: LifecycleCopyGenerator }) {
  await ensureOutboundOrchestratorTables(db);
  const asOf = input.asOf ?? Date.now(), since = asOf - 30 * 86_400_000, limit = Math.max(1, Math.min(250, input.limit ?? 100));
  const rows = await db.prepare("SELECT b.id booking_id,b.customer_id,b.service_code,b.city_id,b.scheduled_end,c.name customer_name FROM canonical_bookings b JOIN canonical_customers c ON c.id=b.customer_id WHERE b.status='completed' AND b.scheduled_end>=? AND b.scheduled_end<=? ORDER BY b.scheduled_end ASC LIMIT ?")
    .bind(new Date(since).toISOString(), new Date(asOf).toISOString(), limit).all<Row>();
  let whatsappQueued = 0, voiceQueued = 0, suppressed = 0;
  for (const row of rows.results) {
    const customerId = text(row.customer_id), bookingId = text(row.booking_id), serviceCode = text(row.service_code), cityId = text(row.city_id) || "blr";
    if (!await marketingConsentGranted(db, customerId)) { suppressed++; continue; }
    const pets = await db.prepare("SELECT name FROM canonical_pets WHERE customer_id=? ORDER BY name LIMIT 8").bind(customerId).all<Row>();
    const petNames = pets.results.map(p => text(p.name)).filter(Boolean);
    const daysSinceService = Math.max(0, Math.floor((asOf - new Date(text(row.scheduled_end)).getTime()) / 86_400_000));
    const copy = await input.copyGenerator({ customerName: text(row.customer_name), serviceCode, petNames, daysSinceService });
    const baseKey = `agent:marketing:30d:${bookingId}`;
    try {
      const wa = await enqueueCommunication(db, { customerId, cityId, channel: "whatsapp", purpose: "marketing", idempotencyKey: `${baseKey}:whatsapp`, templateKey: "lifecycle_30_day_reengagement", createdBy: "system:marketing-manager-agent", bookingId, payload: { text: copy, serviceCode, daysSinceService } });
      if (text((wa as Row).status) === "suppressed") suppressed++; else whatsappQueued++;
    } catch { suppressed++; }
    const sourceKey = `${baseKey}:voice`;
    const voice = await db.prepare("INSERT OR IGNORE INTO outbound_routing_queue (id,source_key,customer_id,lead_id,source_type,lane,priority_score,high_intent,lifecycle_code,target_offer,next_best_service,expected_revenue,ltv,status,context_json,created_at,updated_at) VALUES (?,?,?,NULL,'lifecycle_30_day','ai',55,0,'winback',NULL,?,NULL,0,'queued',?,?,?)")
      .bind(uid("ORQ"), sourceKey, customerId, serviceCode, JSON.stringify({ bookingId, serviceCode, daysSinceService, generatedCopy: copy, sourceAgent: "marketing-manager-agent" }), asOf, asOf).run();
    voiceQueued += Number(voice.meta?.changes || 0);
  }
  return { evaluated: rows.results.length, whatsappQueued, voiceQueued, suppressed, executionBoundaries: ["communication_outbox", "outbound_routing_queue"] };
}
