import { authError, authorize, database, securityAudit } from "../../../lib/server-auth";
import { VOICE_TELEPHONY_SECRET_NAMES } from "../../../lib/voice-call-gate";

type Db = Awaited<ReturnType<typeof database>>;
type Row = Record<string, unknown>;

const internalTables = [
  "canonical_customers", "canonical_pets", "canonical_bookings", "provider_work_orders", "booking_payments",
  "lead_work_items", "revenue_opportunities", "customer_experience_tickets", "sales_performance_daily",
  "command_report_runs", "finance_day_closures", "ops_completion_controls", "communication_delivery_events",
];

async function ensureRunTable(db: Db) {
  await db.prepare("CREATE TABLE IF NOT EXISTS system_integration_runs (id TEXT PRIMARY KEY,status TEXT NOT NULL,internal_passed INTEGER NOT NULL,internal_total INTEGER NOT NULL,external_ready INTEGER NOT NULL,external_total INTEGER NOT NULL,snapshot_json TEXT NOT NULL,actor_email TEXT NOT NULL,created_at INTEGER NOT NULL)").run();
}

async function tableNames(db: Db) {
  const result = await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{ name: string }>();
  return new Set(result.results.map(row => row.name));
}

async function count(db: Db, sql: string) {
  const row = await db.prepare(sql).first<{ count: number }>();
  return Number(row?.count || 0);
}

async function syncCanonicalOperations(db: Db, names: Set<string>) {
  if (!["canonical_customers", "canonical_pets", "canonical_bookings", "provider_work_orders", "booking_payments", "crm_contacts", "ops_completion_controls"].every(name => names.has(name))) return;
  const now = Date.now();
  await db.prepare(`INSERT OR IGNORE INTO crm_contacts (id,name,primary_phone,secondary_phone,email,area,pet_names,pet_summary,stage,owner,source,lifetime_value,next_action,opportunity,created_at,updated_at)
    SELECT c.id,c.name,c.primary_phone,c.secondary_phone,c.email,'Bengaluru',COALESCE((SELECT group_concat(p.name, ', ') FROM canonical_pets p WHERE p.customer_id=c.id),'Pet profile'),COALESCE((SELECT group_concat(COALESCE(p.breed,p.species), ', ') FROM canonical_pets p WHERE p.customer_id=c.id),'Canonical pet profile'),'Active customer','Unassigned',c.source,COALESCE((SELECT SUM(bp.amount) FROM booking_payments bp WHERE bp.customer_id=c.id),0),'Review next-best action','Cross-sell / renewal',c.created_at,?
    FROM canonical_customers c`).bind(now).run();
  await db.prepare(`INSERT OR IGNORE INTO ops_completion_controls (id,booking_id,vertical,owner,scheduled_end_at,status,payment_confirmed,provider_settlement_ready,escalation_level,updated_at)
    SELECT 'OPS-' || b.id,b.id,b.service_code,COALESCE(w.provider_name,'Operations'),CAST(strftime('%s',b.scheduled_end) AS INTEGER)*1000,CASE WHEN b.status='completed' THEN 'completed' ELSE 'in_progress' END,CASE WHEN p.status IN ('paid','captured','completed') THEN 1 ELSE 0 END,0,0,?
    FROM canonical_bookings b JOIN provider_work_orders w ON w.booking_id=b.id JOIN booking_payments p ON p.booking_id=b.id`).bind(now).run();
}

async function buildSnapshot(db: Db, performSync = false) {
  const names = await tableNames(db);
  if (performSync) await syncCanonicalOperations(db, names);
  const refreshed = performSync ? await tableNames(db) : names;
  const schemaReady = internalTables.filter(name => refreshed.has(name));
  const canonicalTotal = refreshed.has("canonical_bookings") ? await count(db, "SELECT COUNT(*) count FROM canonical_bookings") : 0;
  const canonicalComplete = ["canonical_bookings", "canonical_customers", "provider_work_orders", "booking_payments"].every(name => refreshed.has(name))
    ? await count(db, "SELECT COUNT(*) count FROM canonical_bookings b JOIN canonical_customers c ON c.id=b.customer_id JOIN provider_work_orders w ON w.booking_id=b.id JOIN booking_payments p ON p.booking_id=b.id") : 0;
  const opsLinked = ["canonical_bookings", "ops_completion_controls"].every(name => refreshed.has(name))
    ? await count(db, "SELECT COUNT(*) count FROM canonical_bookings b JOIN ops_completion_controls o ON o.booking_id=b.id") : 0;
  const leadsTotal = refreshed.has("lead_work_items") ? await count(db, "SELECT COUNT(*) count FROM lead_work_items") : 0;
  const leadsLinked = ["lead_work_items", "crm_contacts"].every(name => refreshed.has(name))
    ? await count(db, "SELECT COUNT(*) count FROM lead_work_items l JOIN crm_contacts c ON c.id=l.customer_id") : 0;
  const reportRuns = refreshed.has("command_report_runs") ? await count(db, "SELECT COUNT(*) count FROM command_report_runs") : 0;
  const closureRows = refreshed.has("finance_day_closures") ? await count(db, "SELECT COUNT(*) count FROM finance_day_closures") : 0;
  const performanceRows = refreshed.has("sales_performance_daily") ? await count(db, "SELECT COUNT(*) count FROM sales_performance_daily") : 0;
  const reopenRows = refreshed.has("lead_reopen_events") ? await count(db, "SELECT COUNT(*) count FROM lead_reopen_events") : 0;
  const { env } = await import("cloudflare:workers");
  const runtime = env as unknown as Record<string, unknown>;
  const credentials = {
    wati: Boolean(runtime.WATI_API_TOKEN && runtime.WATI_TENANT_URL),
    sms: Boolean(runtime.SMS_API_KEY && runtime.SMS_SENDER_ID),
    // Derived from the same list the dial gate enforces (lib/voice-call-gate.ts). Held separately, this
    // surface reported telephony as "configured" on three of the six variables the receiver actually
    // needs - a line that could neither place a call nor verify a callback - and a future change to one
    // list would silently disagree with the other.
    telephony: VOICE_TELEPHONY_SECRET_NAMES.every(name => Boolean(runtime[name])),
    scheduler: Boolean(runtime.AUTOMATION_CRON_SECRET),
  };
  const controls = [
    { id: "lead-reopening", label: "Automatic 30/60/90-day lead reopening", status: refreshed.has("lead_reopen_events") && refreshed.has("lead_work_items") ? "uat_closed" : "missing", evidence: `${reopenRows} reopen event(s) recorded; conversion, opt-out and cycle limits enforced` },
    { id: "communications", label: "Live WATI, SMS and telephony delivery", status: credentials.wati && credentials.sms && credentials.telephony ? "ready_for_live_test" : "external_setup_required", evidence: `WATI ${credentials.wati ? "configured" : "missing"} · SMS ${credentials.sms ? "configured" : "missing"} · Telephony ${credentials.telephony ? "configured" : "missing"}` },
    { id: "incentives", label: "Sales incentives and company-wide leaderboard", status: refreshed.has("sales_performance_daily") ? "uat_closed" : "missing", evidence: `${performanceRows} employee performance row(s); collection and refund guardrails available` },
    { id: "reports", label: "Automated 7 PM daily/weekly/monthly reports", status: refreshed.has("command_report_runs") ? (credentials.scheduler ? "ready_for_live_test" : "uat_closed") : "missing", evidence: `${reportRuns} report run(s); ${credentials.scheduler ? "scheduler configured" : "manual UAT runner until production scheduler is connected"}` },
    { id: "accounts", label: "Mandatory Accounts day closure", status: refreshed.has("finance_day_closures") ? "uat_closed" : "missing", evidence: `${closureRows} day-close record(s); six checks and variance note enforced` },
    { id: "operations", label: "Ops completion and escalation enforcement", status: refreshed.has("ops_completion_controls") && (canonicalTotal === 0 || opsLinked === canonicalTotal) ? "uat_closed" : "partial", evidence: `${opsLinked}/${canonicalTotal} canonical booking(s) linked to Ops completion control` },
  ];
  const integrations = [
    { name: "Identity & RBAC", from: "Workspace identity", to: "Privileged APIs", passed: refreshed.has("app_users") && refreshed.has("role_definitions") },
    { name: "Canonical lifecycle", from: "Customer + Pet", to: "Booking + Work order + Payment", passed: canonicalTotal > 0 && canonicalComplete === canonicalTotal, detail: `${canonicalComplete}/${canonicalTotal} complete` },
    { name: "CRM ownership", from: "Customer / Lead", to: "Revenue 100 + RNR", passed: leadsTotal > 0 && leadsLinked === leadsTotal, detail: `${leadsLinked}/${leadsTotal} leads linked` },
    { name: "Operations control", from: "Booking / Work order", to: "Evidence + Escalation + Ticket", passed: canonicalTotal === 0 || opsLinked === canonicalTotal, detail: `${opsLinked}/${canonicalTotal} bookings linked` },
    { name: "Finance control", from: "Payment / Refund", to: "Accounts day closure", passed: refreshed.has("booking_payments") && refreshed.has("finance_day_closures") },
    { name: "Management intelligence", from: "CRM + Ops + Finance", to: "Leaderboard + 7 PM report", passed: refreshed.has("sales_performance_daily") && refreshed.has("command_report_runs") },
  ];
  const internalPassed = integrations.filter(item => item.passed).length;
  const externalReady = Object.values(credentials).filter(Boolean).length;
  return {
    checkedAt: Date.now(), environment: "UAT", schema: { ready: schemaReady.length, total: internalTables.length }, credentials, controls, integrations,
    summary: { internalPassed, internalTotal: integrations.length, externalReady, externalTotal: Object.keys(credentials).length, uatStatus: controls.every(item => item.status !== "missing" && item.status !== "partial") && internalPassed === integrations.length ? "integrated" : "action_required", liveStatus: externalReady === Object.keys(credentials).length ? "ready_for_controlled_test" : "blocked_on_external_setup" },
  };
}

export async function GET(request: Request) {
  try {
    await authorize(request, "launch.view");
    const db = await database(); await ensureRunTable(db);
    const snapshot = await buildSnapshot(db);
    const latest = await db.prepare("SELECT id,status,actor_email,created_at FROM system_integration_runs ORDER BY created_at DESC LIMIT 1").first<Row>();
    return Response.json({ ...snapshot, latestRun: latest || null });
  } catch (error) { return authError(error, "Unable to load system integration control"); }
}

export async function POST(request: Request) {
  try {
    const actor = await authorize(request, "launch.manage");
    const db = await database(); await ensureRunTable(db);
    const snapshot = await buildSnapshot(db, true);
    const runId = `INT-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 5).toUpperCase()}`;
    await db.prepare("INSERT INTO system_integration_runs (id,status,internal_passed,internal_total,external_ready,external_total,snapshot_json,actor_email,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(runId, snapshot.summary.uatStatus, snapshot.summary.internalPassed, snapshot.summary.internalTotal, snapshot.summary.externalReady, snapshot.summary.externalTotal, JSON.stringify(snapshot), actor.email, snapshot.checkedAt).run();
    await securityAudit(db, actor, "full_integration_confirmation", "platform", runId, "completed", snapshot.summary);
    return Response.json({ ok: true, runId, ...snapshot, latestRun: { id: runId, status: snapshot.summary.uatStatus, actor_email: actor.email, created_at: snapshot.checkedAt } }, { status: 201 });
  } catch (error) { return authError(error, "Unable to run system integration confirmation"); }
}
