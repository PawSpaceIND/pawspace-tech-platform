import { ensureVoiceCallTables, recordVoiceConsent, requestControlledCarrierUatCall } from "./voice-outbound-governance";

type Env = Record<string, unknown>;
type Row = Record<string, unknown>;
const text = (value: unknown) => String(value ?? "").trim();
const phoneKey = (value: unknown) => text(value).replace(/\D/g, "").slice(-10);

export const VOICE_CARRIER_UAT_RUN_AT = "2026-09-06T02:30:00.000Z"; // 08:00 IST
const RUN_ID = "VOICE-UAT-20260906-CONTROLLED-RETRY-1";

function requireUatConfig(env: Env) {
  if (text(env.PAWSPACE_VOICE_ENV) !== "uat" || text(env.PAWSPACE_VOICE_UAT_APPROVED).toLowerCase() !== "true") throw new Error("carrier UAT scheduler is enabled only in approved UAT mode");
  if (text(env.PAWSPACE_VOICE_UAT_AUTORUN).toLowerCase() !== "true") throw new Error("PAWSPACE_VOICE_UAT_AUTORUN is not enabled");
  const allowlist = text(env.PAWSPACE_VOICE_UAT_ALLOWLIST).split(/[\s,;]+/).map(phoneKey).filter(Boolean);
  const unique = [...new Set(allowlist)];
  if (unique.length !== 1) throw new Error("carrier UAT autorun requires exactly one allowlisted test number");
  const rawNumber = text(env.PAWSPACE_VOICE_UAT_TEST_NUMBER) || text(env.PAWSPACE_VOICE_UAT_ALLOWLIST).split(/[\s,;]+/).find(Boolean) || "";
  if (!rawNumber || phoneKey(rawNumber) !== unique[0]) throw new Error("PAWSPACE_VOICE_UAT_TEST_NUMBER must be the single allowlisted recipient");
  const customerId = text(env.PAWSPACE_VOICE_UAT_CUSTOMER_ID), bookingId = text(env.PAWSPACE_VOICE_UAT_BOOKING_ID), cityId = text(env.PAWSPACE_VOICE_UAT_CITY_ID);
  if (!customerId || !bookingId || !cityId) throw new Error("carrier UAT requires canonical customer, booking and city identifiers");
  if (text(env.PAWSPACE_VOICE_UAT_CONSENT_CONFIRMED).toLowerCase() !== "true") throw new Error("carrier UAT consent has not been explicitly confirmed");
  const consentSource = text(env.PAWSPACE_VOICE_UAT_CONSENT_SOURCE);
  if (consentSource.length < 4) throw new Error("carrier UAT consent source is missing");
  return { rawNumber, customerId, bookingId, cityId, consentSource };
}

export async function ensureVoiceCarrierUatQueue(db: D1Database) {
  await ensureVoiceCallTables(db);
  await db.prepare("CREATE TABLE IF NOT EXISTS voice_carrier_uat_queue (id TEXT PRIMARY KEY,scheduled_for INTEGER NOT NULL,status TEXT NOT NULL,call_id TEXT,last_state TEXT,failure_class TEXT,prepared_at INTEGER NOT NULL,started_at INTEGER,finished_at INTEGER,updated_at INTEGER NOT NULL)").run();
}

export async function stageVoiceCarrierUat(db: D1Database, env: Env, asOf = Date.now()) {
  await ensureVoiceCarrierUatQueue(db);
  const cfg = requireUatConfig(env), scheduledFor = Date.parse(VOICE_CARRIER_UAT_RUN_AT);
  const customer = await db.prepare("SELECT id,primary_phone,city_id FROM canonical_customers WHERE id=? LIMIT 1").bind(cfg.customerId).first<Row>();
  if (!customer || phoneKey(customer.primary_phone) !== phoneKey(cfg.rawNumber)) throw new Error("carrier UAT test number does not belong to the configured canonical customer");
  const booking = await db.prepare("SELECT id,customer_id FROM canonical_bookings WHERE id=? LIMIT 1").bind(cfg.bookingId).first<Row>();
  if (!booking || text(booking.customer_id) !== cfg.customerId) throw new Error("carrier UAT booking does not belong to the configured canonical customer");
  await recordVoiceConsent(db, { phone: cfg.rawNumber, subjectType: "customer", subjectId: cfg.customerId, granted: true, source: cfg.consentSource, actorId: "system:voice-uat-preparation", asOf });
  await db.prepare("INSERT INTO voice_carrier_uat_queue (id,scheduled_for,status,prepared_at,updated_at) VALUES (?,?, 'pending',?,?) ON CONFLICT(id) DO UPDATE SET scheduled_for=excluded.scheduled_for,updated_at=excluded.updated_at WHERE voice_carrier_uat_queue.status='pending'").bind(RUN_ID, scheduledFor, asOf, asOf).run();
  return { runId: RUN_ID, scheduledFor, status: "pending", recipientStoredInQueue: false };
}

export async function runDueVoiceCarrierUat(db: D1Database, env: Env, asOf = Date.now()) {
  await ensureVoiceCarrierUatQueue(db);
  const cfg = requireUatConfig(env);
  const row = await db.prepare("SELECT id,scheduled_for,status FROM voice_carrier_uat_queue WHERE id=? LIMIT 1").bind(RUN_ID).first<Row>();
  if (!row) return { status: "not_staged" as const };
  if (text(row.status) !== "pending") return { status: text(row.status) as "running" | "completed" | "failed" };
  if (asOf < Number(row.scheduled_for)) return { status: "not_due" as const, scheduledFor: Number(row.scheduled_for) };

  const claimed = await db.prepare("UPDATE voice_carrier_uat_queue SET status='running',started_at=?,updated_at=? WHERE id=? AND status='pending'").bind(asOf, asOf, RUN_ID).run();
  if (!Number(claimed.meta?.changes || 0)) return { status: "already_claimed" as const };
  try {
    const result = await requestControlledCarrierUatCall(db, env, {
      idempotencyKey: "voice-carrier-uat:2026-09-06:controlled-retry-1",
      useCase: "booking_confirmation",
      phone: cfg.rawNumber,
      cityId: cfg.cityId,
      customerId: cfg.customerId,
      bookingId: cfg.bookingId,
      asOf,
    });
    const status = result.dialed ? "completed" : "failed";
    await db.prepare("UPDATE voice_carrier_uat_queue SET status=?,call_id=?,last_state=?,failure_class=?,finished_at=?,updated_at=? WHERE id=?").bind(status, result.callId || null, result.state || null, result.dialed ? null : result.state || "policy_block", Date.now(), Date.now(), RUN_ID).run();
    return { status, callId: result.callId, state: result.state, dialed: result.dialed };
  } catch (error) {
    await db.prepare("UPDATE voice_carrier_uat_queue SET status='failed',failure_class='execution_exception',finished_at=?,updated_at=? WHERE id=?").bind(Date.now(), Date.now(), RUN_ID).run();
    throw error;
  }
}

export async function runVoiceCarrierUatScheduler(db: D1Database, env: Env, asOf = Date.now()) {
  if (text(env.PAWSPACE_VOICE_ENV) !== "uat" || text(env.PAWSPACE_VOICE_UAT_AUTORUN).toLowerCase() !== "true") return { status: "disabled" as const };
  const table = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='voice_carrier_uat_queue'").first<Row>().catch(() => null);
  if (!table) await stageVoiceCarrierUat(db, env, asOf);
  else {
    const staged = await db.prepare("SELECT id FROM voice_carrier_uat_queue WHERE id=? LIMIT 1").bind(RUN_ID).first<Row>();
    if (!staged) await stageVoiceCarrierUat(db, env, asOf);
  }
  return runDueVoiceCarrierUat(db, env, asOf);
}
