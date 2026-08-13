// Generates scripts/uat-demo-seed.sql — the demo data for the team surfaces that render empty on a
// fresh staging database even though their modules work: the sales performance leaderboard (no reps
// mapped, no lead activity) and the governed campaign command centre (no campaigns, no audience).
//
// It layers on top of scripts/staging-seed.sql and reuses that seed's customers (CUS0000…) and
// bookings (BK00000…), so load the staging seed first. Every table shape below is copied verbatim from
// the module that owns it, every insert is INSERT OR IGNORE, and every timestamp is derived from a
// fixed base, so the file is deterministic and safe to re-run.
//
// Run:  node scripts/uat-demo-seed-gen.mjs
// Load: npx wrangler d1 execute pawspace-staging --remote --file=scripts/uat-demo-seed.sql
import { writeFileSync } from "node:fs";

const BASE = Date.UTC(2026, 7, 1), DAY = 86400000;
const q = (value) => (value === null || value === undefined ? "NULL" : typeof value === "number" ? String(value) : `'${String(value).replace(/'/g, "''")}'`);
const insert = (table, row) => `INSERT OR IGNORE INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.values(row).map(q).join(",")});`;
const s = [];

s.push("-- PawSpace UAT demo seed (generated). Load scripts/staging-seed.sql first. Safe to re-run.");

// ---------------------------------------------------------------- table shapes (verbatim from lib/)
for (const ddl of [
  "CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role_code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS lead_assignment_memberships (id TEXT PRIMARY KEY,employee_email TEXT NOT NULL,team_code TEXT NOT NULL,service_codes_json TEXT NOT NULL,city_ids_json TEXT NOT NULL,language_codes_json TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,workload_cap_override INTEGER,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(employee_email,team_code))",
  "CREATE TABLE IF NOT EXISTS lead_assignments (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,lead_id TEXT NOT NULL,employee_email TEXT,team_code TEXT NOT NULL,policy_id TEXT NOT NULL,policy_version INTEGER NOT NULL,assignment_reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'current',fallback_queue TEXT,assigned_at INTEGER NOT NULL,accepted_at INTEGER,ended_at INTEGER,ended_reason TEXT,previous_assignment_id TEXT,detail_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS lead_work_items (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, source TEXT NOT NULL, service TEXT NOT NULL, owner TEXT NOT NULL, manager TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', stage TEXT NOT NULL DEFAULT 'day_1', work_day INTEGER NOT NULL DEFAULT 1, assigned_at INTEGER NOT NULL, first_action_due_at INTEGER NOT NULL, manager_alert_at INTEGER NOT NULL, first_action_at INTEGER, call_attempts INTEGER NOT NULL DEFAULT 0, whatsapp_attempts INTEGER NOT NULL DEFAULT 0, last_outcome TEXT, next_action_at INTEGER, recycle_at INTEGER, recycle_cycle INTEGER NOT NULL DEFAULT 0, opt_out INTEGER NOT NULL DEFAULT 0, converted_booking_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS lead_sla_clocks (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,lead_id TEXT NOT NULL,assignment_id TEXT NOT NULL,policy_id TEXT NOT NULL,policy_version INTEGER NOT NULL,clock_type TEXT NOT NULL,cycle INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'running',started_at INTEGER NOT NULL,due_at INTEGER NOT NULL,manager_escalation_due_at INTEGER NOT NULL,reassignment_due_at INTEGER NOT NULL,met_at INTEGER,breached_at INTEGER,paused_at INTEGER,pause_reason TEXT,paused_remaining_minutes INTEGER,last_action_at INTEGER,next_action_at INTEGER,detail_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(lead_id,clock_type,cycle))",
  "CREATE TABLE IF NOT EXISTS lead_sla_events (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,clock_id TEXT NOT NULL,lead_id TEXT NOT NULL,event_type TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sales_productivity_policies (id TEXT PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',version INTEGER NOT NULL DEFAULT 1,team_code TEXT NOT NULL,timezone TEXT NOT NULL,meaningful_action_types_json TEXT NOT NULL,qualified_outcomes_json TEXT NOT NULL,revenue_basis TEXT NOT NULL,require_canonical_lead_booking_link INTEGER NOT NULL DEFAULT 1,effective_from INTEGER NOT NULL,effective_until INTEGER,approval_reference TEXT,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS revenue_mission_events (id TEXT PRIMARY KEY,mission_id TEXT NOT NULL,source_event_key TEXT NOT NULL,event_type TEXT NOT NULL,customer_id TEXT NOT NULL,booking_id TEXT NOT NULL,payment_id TEXT,refund_id TEXT,service_code TEXT NOT NULL,city_id TEXT NOT NULL,gross_amount REAL NOT NULL DEFAULT 0,refund_amount REAL NOT NULL DEFAULT 0,eligible_amount REAL NOT NULL DEFAULT 0,currency TEXT NOT NULL,source_at INTEGER NOT NULL,source_version TEXT NOT NULL,attribution_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,UNIQUE(mission_id,source_event_key))",
  // The productivity fact run reads CX escalations and revenue-opportunity suppressions per rep; a
  // young database may not have created those tables yet, and the run must not fail on their absence.
  "CREATE TABLE IF NOT EXISTS customer_experience_tickets (id TEXT PRIMARY KEY, customer_id TEXT, booking_id TEXT, lead_id TEXT, category TEXT NOT NULL, priority TEXT NOT NULL, subject TEXT NOT NULL, detail TEXT NOT NULL, owner TEXT NOT NULL, manager TEXT NOT NULL, sla_due_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', escalation_level INTEGER NOT NULL DEFAULT 0, customer_status TEXT NOT NULL DEFAULT 'We received your request', resolution TEXT, root_cause TEXT, resolution_evidence TEXT, reopened_count INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, resolved_at INTEGER)",
  "CREATE TABLE IF NOT EXISTS canonical_revenue_opportunities (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,opportunity_type TEXT NOT NULL,service_code TEXT,reason TEXT NOT NULL,status TEXT NOT NULL,preferred_channel TEXT NOT NULL,estimated_value REAL NOT NULL DEFAULT 0,confidence REAL NOT NULL DEFAULT 0,signal_snapshot_json TEXT NOT NULL,suppression_reasons_json TEXT NOT NULL DEFAULT '[]',policy_id TEXT NOT NULL,policy_version INTEGER NOT NULL,source_key TEXT NOT NULL,converted_booking_id TEXT,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(customer_id,source_key,policy_id,policy_version))",
  "CREATE TABLE IF NOT EXISTS governed_marketing_campaigns (id TEXT PRIMARY KEY,name TEXT NOT NULL,objective TEXT NOT NULL,service_code TEXT,city_id TEXT,audience_rule_json TEXT NOT NULL DEFAULT '{}',budget_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',holdout_percent INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'draft',approval_status TEXT NOT NULL DEFAULT 'approval_required',approved_by TEXT,approved_at INTEGER,start_at INTEGER,end_at INTEGER,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS marketing_audience_snapshots (id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,snapshot_at INTEGER NOT NULL,total_candidates INTEGER NOT NULL,eligible_count INTEGER NOT NULL,holdout_count INTEGER NOT NULL,suppressed_count INTEGER NOT NULL,policy_json TEXT NOT NULL,created_by TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS marketing_audience_members (snapshot_id TEXT NOT NULL,campaign_id TEXT NOT NULL,customer_id TEXT NOT NULL,cohort TEXT NOT NULL,suppression_reason TEXT,PRIMARY KEY(snapshot_id,customer_id))",
  "CREATE TABLE IF NOT EXISTS marketing_attribution_facts (id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,customer_id TEXT,lead_id TEXT,booking_id TEXT,collection_id TEXT,source TEXT NOT NULL,medium TEXT,spend_amount REAL,booked_revenue REAL,collected_revenue REAL,contribution_margin REAL,attribution_model TEXT NOT NULL DEFAULT 'unconfigured',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
]) s.push(`${ddl};`);

// ------------------------------------------------------------------------------------ sales team
const REPS = [
  { email: "asha.rao@pawspace.in", name: "Asha Rao", leads: 9, qualified: 5, converted: 3 },
  { email: "vikram.shetty@pawspace.in", name: "Vikram Shetty", leads: 7, qualified: 4, converted: 2 },
  { email: "neha.kulkarni@pawspace.in", name: "Neha Kulkarni", leads: 6, qualified: 2, converted: 2 },
  { email: "rohit.menon@pawspace.in", name: "Rohit Menon", leads: 5, qualified: 1, converted: 1 },
];
const AMOUNTS = [799, 1299, 699, 899, 599];
let leadSeq = 0, bookingSeq = 0;

s.push("-- Sales team: reps, their team membership, and the lead work the leaderboard measures.");
for (const [repIndex, rep] of REPS.entries()) {
  s.push(insert("app_users", { id: `USR-SALES-${repIndex}`, email: rep.email, name: rep.name, role_code: "associate", status: "active", created_at: BASE - 120 * DAY, updated_at: BASE - 120 * DAY }));
  s.push(insert("lead_assignment_memberships", {
    id: `LAM-SALES-${repIndex}`, employee_email: rep.email, team_code: "sales",
    service_codes_json: JSON.stringify(["grooming", "boarding", "dog_training"]), city_ids_json: JSON.stringify(["blr", "hyd"]),
    language_codes_json: JSON.stringify(["en", "hi"]), active: 1, workload_cap_override: null,
    created_by: "uat-demo-seed", created_at: BASE - 120 * DAY, updated_by: "uat-demo-seed", updated_at: BASE - 120 * DAY,
  }));

  for (let index = 0; index < rep.leads; index += 1) {
    const leadId = `LEAD-UAT-${String(leadSeq).padStart(4, "0")}`;
    const assignmentId = `ASG-UAT-${String(leadSeq).padStart(4, "0")}`;
    const clockId = `CLK-UAT-${String(leadSeq).padStart(4, "0")}`;
    const customerId = `CUS${String(leadSeq * 3 % 220).padStart(4, "0")}`;
    // Spread the work across the last three weeks so 7/30/90-day windows all show something.
    const at = BASE - (3 + (leadSeq % 18)) * DAY;
    const qualified = index < rep.qualified;
    const converted = index < rep.converted;
    const bookingId = converted ? `BK${String(bookingSeq++).padStart(5, "0")}` : null;
    const amount = AMOUNTS[leadSeq % AMOUNTS.length];
    const metSla = index % 3 !== 2;

    s.push(insert("lead_work_items", {
      id: leadId, customer_id: customerId, source: ["website", "whatsapp", "referral"][index % 3], service: ["grooming", "boarding", "dog_training"][index % 3],
      owner: rep.email, manager: "sales.manager@pawspace.in", status: converted ? "converted" : "active", stage: "day_1", work_day: 1,
      assigned_at: at, first_action_due_at: at + 600000, manager_alert_at: at + 1_800_000, first_action_at: at + 300000,
      call_attempts: 1 + (index % 3), whatsapp_attempts: index % 2, last_outcome: qualified ? "qualified" : "call_back_later",
      next_action_at: at + 2 * DAY, recycle_at: null, recycle_cycle: 0, opt_out: 0, converted_booking_id: bookingId,
      created_at: at, updated_at: at + 3 * DAY,
    }));
    s.push(insert("lead_assignments", {
      id: assignmentId, idempotency_key: `${assignmentId}-idem`, lead_id: leadId, employee_email: rep.email, team_code: "sales",
      policy_id: "LAP-UAT-DEMO", policy_version: 1, assignment_reason: "round_robin", status: "current", fallback_queue: null,
      assigned_at: at, accepted_at: at + 120000, ended_at: null, ended_reason: null, previous_assignment_id: null,
      detail_json: "{}", created_by: "uat-demo-seed", created_at: at,
    }));
    s.push(insert("lead_sla_clocks", {
      id: clockId, idempotency_key: `${clockId}-idem`, lead_id: leadId, assignment_id: assignmentId, policy_id: "LSP-UAT-DEMO", policy_version: 1,
      clock_type: "first_response", cycle: 1, status: metSla ? "met" : "breached", started_at: at, due_at: at + 600000,
      manager_escalation_due_at: at + 1_800_000, reassignment_due_at: at + 3_600_000, met_at: metSla ? at + 300000 : null,
      breached_at: metSla ? null : at + 900000, paused_at: null, pause_reason: null, paused_remaining_minutes: null,
      last_action_at: at + 300000, next_action_at: at + 2 * DAY, detail_json: "{}", created_by: "uat-demo-seed", created_at: at, updated_at: at + 300000,
    }));
    // Every touch is a recorded action; its outcome is what makes the lead "qualified" under a policy.
    for (const [actionIndex, actionType] of ["call", "whatsapp"].entries()) {
      const eventId = `EVT-UAT-${String(leadSeq).padStart(4, "0")}-${actionIndex}`;
      s.push(insert("lead_sla_events", {
        id: eventId, idempotency_key: `${eventId}-idem`, clock_id: clockId, lead_id: leadId, event_type: "action_recorded", actor_id: rep.email,
        detail_json: JSON.stringify({ actionType, outcome: actionIndex === 0 && qualified ? "qualified" : converted ? "booked" : "call_back_later" }),
        created_at: at + 300000 + actionIndex * 60000,
      }));
    }
    if (converted) {
      // Money for a converted lead comes from the revenue ledger, keyed to the booking.
      s.push(insert("revenue_mission_events", {
        id: `RME-UAT-${leadSeq}-c`, mission_id: "MIS-UAT-DEMO", source_event_key: `${bookingId}-collected`, event_type: "collected",
        customer_id: customerId, booking_id: bookingId, payment_id: `PAY-${bookingId}`, refund_id: null, service_code: "grooming", city_id: "blr",
        gross_amount: amount, refund_amount: 0, eligible_amount: amount, currency: "INR", source_at: at + 2 * DAY,
        source_version: "uat_demo_seed:v1", attribution_json: "{}", created_at: at + 2 * DAY,
      }));
      if (leadSeq % 7 === 0) {
        s.push(insert("revenue_mission_events", {
          id: `RME-UAT-${leadSeq}-r`, mission_id: "MIS-UAT-DEMO", source_event_key: `${bookingId}-refunded`, event_type: "refunded",
          customer_id: customerId, booking_id: bookingId, payment_id: `PAY-${bookingId}`, refund_id: `RFD-${bookingId}`, service_code: "grooming", city_id: "blr",
          gross_amount: 0, refund_amount: Math.round(amount / 2), eligible_amount: 0, currency: "INR", source_at: at + 3 * DAY,
          source_version: "uat_demo_seed:v1", attribution_json: "{}", created_at: at + 3 * DAY,
        }));
      }
    }
    leadSeq += 1;
  }
}

// An active policy so the leaderboard has a definition to measure against. The fact run is deliberately
// left out: generating it is one click on /team/performance, which is also how the pipeline is proven.
s.push("-- Active productivity policy. Generate the report from /team/performance to fill the board.");
s.push(insert("sales_productivity_policies", {
  id: "SPP-UAT-DEMO", name: "Sales productivity (UAT baseline)", status: "active_uat", version: 1, team_code: "sales", timezone: "Asia/Kolkata",
  meaningful_action_types_json: JSON.stringify(["call", "whatsapp"]), qualified_outcomes_json: JSON.stringify(["qualified", "booked"]),
  revenue_basis: "net_collected", require_canonical_lead_booking_link: 1, effective_from: BASE - 365 * DAY, effective_until: null,
  approval_reference: "UAT-DEMO-SEED", created_by: "uat-demo-seed", created_at: BASE - 120 * DAY, updated_by: "uat-demo-seed", updated_at: BASE - 120 * DAY,
}));

// -------------------------------------------------------------------------------------- marketing
s.push("-- Governed campaigns: one live with a taken audience snapshot, one awaiting approval.");
const CAMPAIGNS = [
  { id: "CMP-UAT-MONSOON", name: "Monsoon grooming refresh", objective: "reactivation", service: "grooming", city: "blr", budget: 45000, holdout: 10, status: "active", approval: "approved" },
  { id: "CMP-UAT-BOARDING", name: "Festive boarding pre-book", objective: "acquisition", service: "boarding", city: "hyd", budget: 60000, holdout: 15, status: "draft", approval: "approval_required" },
];
for (const campaign of CAMPAIGNS) {
  s.push(insert("governed_marketing_campaigns", {
    id: campaign.id, name: campaign.name, objective: campaign.objective, service_code: campaign.service, city_id: campaign.city,
    audience_rule_json: JSON.stringify({ marketingConsent: true, serviceCode: campaign.service, cityId: campaign.city }),
    budget_amount: campaign.budget, currency: "INR", holdout_percent: campaign.holdout, status: campaign.status, approval_status: campaign.approval,
    approved_by: campaign.approval === "approved" ? "marketing.head@pawspace.in" : null, approved_at: campaign.approval === "approved" ? BASE - 20 * DAY : null,
    start_at: campaign.status === "active" ? BASE - 18 * DAY : null, end_at: campaign.status === "active" ? BASE + 12 * DAY : null,
    created_by: "uat-demo-seed", created_at: BASE - 25 * DAY, updated_at: BASE - 18 * DAY,
  }));
}

// The snapshot mirrors what snapshotCampaignAudience() records: consent-eligible customers, an explicit
// holdout, and everyone else suppressed with the reason they were held back.
const live = CAMPAIGNS[0];
const audience = [];
for (let index = 0; index < 220; index += 3) audience.push(`CUS${String(index).padStart(4, "0")}`);
const holdout = audience.filter((_, index) => index % 10 === 0);
const suppressed = audience.filter((_, index) => index % 7 === 0 && index % 10 !== 0);
const eligible = audience.filter((id) => !holdout.includes(id) && !suppressed.includes(id));
s.push(insert("marketing_audience_snapshots", {
  id: "MAS-UAT-MONSOON", campaign_id: live.id, snapshot_at: BASE - 18 * DAY, total_candidates: audience.length,
  eligible_count: eligible.length, holdout_count: holdout.length, suppressed_count: suppressed.length,
  policy_json: JSON.stringify({ requiresMarketingConsent: true, holdoutPercent: live.holdout, suppressionReasons: ["marketing_consent_missing"] }),
  created_by: "uat-demo-seed",
}));
for (const customerId of audience) {
  const cohort = holdout.includes(customerId) ? "holdout" : suppressed.includes(customerId) ? "suppressed" : "eligible";
  s.push(insert("marketing_audience_members", {
    snapshot_id: "MAS-UAT-MONSOON", campaign_id: live.id, customer_id: customerId, cohort,
    suppression_reason: cohort === "suppressed" ? "marketing_consent_missing" : null,
  }));
}

// Attribution facts carry the spend the unit-economics CAC line refuses to invent.
for (let index = 0; index < 6; index += 1) {
  const bookingId = `BK${String(index).padStart(5, "0")}`;
  s.push(insert("marketing_attribution_facts", {
    id: `MAF-UAT-${index}`, campaign_id: live.id, customer_id: `CUS${String(index * 3).padStart(4, "0")}`, lead_id: null, booking_id: bookingId,
    collection_id: null, source: "meta", medium: "paid_social", spend_amount: 1500, booked_revenue: AMOUNTS[index % AMOUNTS.length],
    collected_revenue: AMOUNTS[index % AMOUNTS.length], contribution_margin: null, attribution_model: "last_touch_uat",
    created_at: BASE - 15 * DAY, updated_at: BASE - 15 * DAY,
  }));
}

writeFileSync(new URL("./uat-demo-seed.sql", import.meta.url), `${s.join("\n")}\n`);
console.log(`scripts/uat-demo-seed.sql written: ${s.length} statements, ${REPS.length} reps, ${leadSeq} leads, ${CAMPAIGNS.length} campaigns, ${audience.length} audience members`);
