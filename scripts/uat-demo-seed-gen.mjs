// Generates scripts/uat-demo-seed.sql — a deterministic, re-runnable demo layer that puts REAL,
// derivable data behind EVERY module UI, so no staging page opens empty.
//
// It complements (never replaces) the two existing seeds:
//   scripts/staging-seed.sql   — 220 customers / ~307 bookings (volume)
//   scripts/employee-seed.sql  — the salaried employee + payroll/tax baseline
// This one adds the module-level rows those two don't carry: service lifecycle (stays, walk
// sessions, taxi trips), AI conversations, app funnel, productivity facts, attendance/leave,
// incentives, ledger + bills + expenses, commercial terms + payouts, ratings, vaccinations,
// birthdays, CRM leads/tickets and provider identity links — plus, from #158, the sales team the
// performance leaderboard measures and the governed campaigns behind the marketing command centre.
//
// Two layers with two different assumptions, deliberately kept apart in section 3 and 3b: the UATD-*
// rows are self-contained and prove out on an empty database, while the sales and campaign rows
// reference staging-seed.sql's customers and bookings so those screens are measured against real
// volume. Load staging-seed.sql first.
//
// SAFETY: every CREATE TABLE is COPIED VERBATIM from the source file that owns it (never retyped),
// and every column name used in an INSERT is validated against that real DDL — the generator throws
// rather than emit a statement referencing a column that does not exist. All rows are namespaced
// `UATD-*` and written with INSERT OR IGNORE, so the script is safe to re-run and never collides
// with the other seeds.
//
// The AI block is the one exception to "hand-written rows": those tables store an engine vocabulary
// (outcome, policy_decision, intent_code, queue_code, immutable_hash), so scripts/ai-demo-run.mjs
// executes the REAL AI libs against an in-memory database and this generator dumps whatever they
// wrote. See that file for why.
//
// Run:   node --experimental-strip-types scripts/uat-demo-seed-gen.mjs
// Load:  npx wrangler d1 execute pawspace-staging --remote --file=scripts/uat-demo-seed.sql

import fs from "node:fs";
import { AI_TABLES, runRealAiDemo } from "./ai-demo-run.mjs";

// ---------------------------------------------------------------------------
// 1. Copy the real DDL out of the files that own each table.
// ---------------------------------------------------------------------------
const SOURCES = [
  "lib/server-auth.ts",
  "lib/people-foundation.ts",
  "lib/payroll-engine.ts",
  "lib/attendance-leave.ts",
  "lib/incentive-engine.ts",
  "lib/sales-incentive-engine.ts",
  "lib/sales-productivity-governance.ts",
  "lib/provider-capacity-governance.ts",
  "lib/provider-commercial-terms.ts",
  "lib/provider-workspace.ts",
  "lib/boarding-governance.ts",
  "lib/walking-ops-governance.ts",
  "lib/taxi-ops-governance.ts",
  "lib/ai-conversation-orchestrator.ts",
  "lib/ai-human-handoff.ts",
  "lib/ai-voice-uat.ts",
  "lib/ai-business-configuration.ts",
  "lib/ai-governance.ts",
  "lib/ai-audience-rollout.ts",
  "lib/ai-analytics.ts",
  "lib/communication-engine.ts",
  "lib/conversation-governance.ts",
  "lib/app-to-revenue-funnel.ts",
  "lib/gst-accounting.ts",
  "lib/people-finance-integration.ts",
  "lib/booking-rating.ts",
  "lib/pet-vaccination-governance.ts",
  "lib/pet-birthday-governance.ts",
  "app/api/walking-bookings/route.ts",
  "app/api/revenue-crm/route.ts",
  "app/api/crm/route.ts",
  "app/api/uat-scheduling/route.ts",
  // Owners of the sales-performance and campaign tables merged in from #158. That branch inlined these
  // CREATE TABLE strings by hand; naming the owning file instead means the column validation below
  // covers them too, which is the whole point of extracting DDL rather than retyping it.
  "lib/lead-assignment-governance.ts",
  "lib/lead-sla-governance.ts",
  "lib/revenue-mission-control.ts",
  "lib/marketing-governance.ts",
];

const ddl = new Map(); // table -> { sql, cols }

function splitTopLevel(body) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

for (const file of SOURCES) {
  if (!fs.existsSync(file)) throw new Error(`DDL source missing: ${file}`);
  const src = fs.readFileSync(file, "utf8");
  const re = /CREATE TABLE IF NOT EXISTS ([a-z_]+) \(([\s\S]*?)\)(?=["'`])/g;
  let m;
  while ((m = re.exec(src))) {
    const table = m[1];
    if (ddl.has(table)) continue; // first owner wins; identical CREATE IF NOT EXISTS elsewhere
    const cols = splitTopLevel(m[2])
      .map((c) => c.split(/\s+/)[0])
      .filter((c) => !/^(UNIQUE|PRIMARY|FOREIGN|CHECK)\b/i.test(c) && !c.startsWith("UNIQUE("));
    ddl.set(table, { sql: m[0], cols: new Set(cols) }); // m[0] already ends at the closing paren
  }
}

// ---------------------------------------------------------------------------
// 2. Emit helpers — every insert is validated against the real column set.
// ---------------------------------------------------------------------------
const lines = [];
const usedTables = new Set();

// A value that must be emitted as a SQL expression rather than a literal — for the few rows whose
// meaning is "relative to when the seed is loaded" rather than "this exact instant". See LOAD_NOW.
const raw = (sql) => ({ rawSql: sql });

const q = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "object" && typeof v.rawSql === "string") return v.rawSql;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  return `'${String(v).replaceAll("'", "''")}'`;
};

function insert(table, row) {
  const meta = ddl.get(table);
  if (!meta) throw new Error(`No DDL captured for table '${table}' — add its owning file to SOURCES`);
  for (const key of Object.keys(row)) {
    if (!meta.cols.has(key)) throw new Error(`Column '${key}' does not exist on '${table}'. Real columns: ${[...meta.cols].join(",")}`);
  }
  usedTables.add(table);
  const keys = Object.keys(row);
  lines.push(`INSERT OR IGNORE INTO ${table} (${keys.join(",")}) VALUES (${keys.map((k) => q(row[k])).join(",")});`);
}

// ---------------------------------------------------------------------------
// 3. The demo data. Fixed timestamps → byte-identical output on every run.
// ---------------------------------------------------------------------------
const NOW = Date.UTC(2026, 7, 13, 6, 0, 0); // 2026-08-13, the UAT "today"
const DAY = 86_400_000;
const at = (offsetDays, hour = 10) => NOW + offsetDays * DAY + (hour - 6) * 3_600_000;
const isoAt = (offsetDays, hour = 10) => new Date(at(offsetDays, hour)).toISOString();
const dateAt = (offsetDays) => new Date(NOW + offsetDays * DAY).toISOString().slice(0, 10);
const MONTH = dateAt(0).slice(0, 7);
const PREV_MONTH = new Date(Date.UTC(2026, 6, 1)).toISOString().slice(0, 7);

// The performance board is anchored on the LIVE clock: lib/employee-performance-center.ts only picks
// up a fact run whose period_start falls inside the window on screen. A run frozen at `at(-30)`..`at(0)`
// therefore drops off the 30-day board one day after this file is generated, and the demo employee's
// self-service performance row goes blank — the exact "page opens empty" failure this seed exists to
// prevent. So the demo run's window is emitted as a SQL expression and stamped when the seed is
// LOADED, not when it is generated. Output stays byte-identical because the expression is literal text.
//
// How long a load stays visible: the board keeps a run while `period_start >= now - (days + 1)`, so a
// run starting D days before the load survives (days + 1 - D) days on a `days`-wide board. At D = 7
// that is 24 days on the 30-day board self-service reads — the full UAT cycle and then some — against
// the ONE day the frozen window managed. It also means the 7-day board only carries it for a day;
// that board wants a report generated for the window on screen, which is what it has always wanted.
const LOAD_NOW = raw("(unixepoch() * 1000)");
const LOAD_AGO = (days) => raw(`(unixepoch() * 1000 - ${days * DAY})`);

// Each INSERT evaluates unixepoch() separately, so a load that straddles a second boundary would give
// the run and its facts different windows. The facts read theirs back off the run instead.
const RUN_PERIOD_START = raw("(SELECT period_start FROM sales_productivity_fact_runs WHERE id='UATD-SPFR-1')");
const RUN_PERIOD_END = raw("(SELECT period_end FROM sales_productivity_fact_runs WHERE id='UATD-SPFR-1')");

// --- customers + pets -------------------------------------------------------
const CUSTOMERS = [
  { id: "UATD-CUS-1", name: "Demo · Ananya Rao", phone: "9800000001", city: "blr", zone: "blr-east", pet: "Bruno", species: "dog", breed: "Labrador" },
  { id: "UATD-CUS-2", name: "Demo · Rahul Menon", phone: "9800000002", city: "blr", zone: "blr-east", pet: "Coco", species: "dog", breed: "Beagle" },
  { id: "UATD-CUS-3", name: "Demo · Meera Shah", phone: "9800000003", city: "blr", zone: "blr-east", pet: "Milo", species: "cat", breed: "Persian" },
  { id: "UATD-CUS-4", name: "Demo · Vikram Reddy", phone: "9800000004", city: "blr", zone: "blr-east", pet: "Rocky", species: "dog", breed: "Indie" },
  { id: "UATD-CUS-5", name: "Demo · Priya Nair", phone: "9800000005", city: "blr", zone: "blr-east", pet: "Simba", species: "dog", breed: "Golden Retriever" },
  { id: "UATD-CUS-6", name: "Demo · Karthik Iyer (lapsed)", phone: "9800000006", city: "blr", zone: "blr-east", pet: "Zara", species: "dog", breed: "Pug" },
];
for (const c of CUSTOMERS) {
  insert("canonical_customers", { id: c.id, city_id: c.city, name: c.name, primary_phone: c.phone, secondary_phone: null, email: null, source: "uat_demo_seed", consent_json: JSON.stringify({ serviceUpdates: true, marketing: true }), created_at: at(-120), updated_at: at(-120) });
  insert("canonical_pets", { id: `${c.id}-PET`, customer_id: c.id, name: c.pet, species: c.species, breed: c.breed, vaccination_status: "up_to_date", source_pet_id: c.pet.toLowerCase(), created_at: at(-120), updated_at: at(-120) });
}

// --- bookings across every vertical, with the JOIN partners the command centre needs ---
// status mix is deliberate: revenue truth (confirmed/completed) vs excluded (cancelled).
const BOOKINGS = [
  { id: "UATD-BK-GROOM-1", cus: "UATD-CUS-1", svc: "grooming", provider: "groom_arun", pkg: "Full Groom", amount: 1299, status: "completed", start: -6, pay: "captured" },
  { id: "UATD-BK-GROOM-2", cus: "UATD-CUS-2", svc: "grooming", provider: "groom_kiran", pkg: "Bath & Brush", amount: 799, status: "confirmed", start: 2, pay: "created" },
  { id: "UATD-BK-TRAIN-1", cus: "UATD-CUS-3", svc: "dog_training", provider: "train_kiran", pkg: "Basic Obedience", amount: 4999, status: "completed", start: -10, pay: "captured" },
  { id: "UATD-BK-TRAIN-2", cus: "UATD-CUS-4", svc: "dog_training", provider: "train_meera", pkg: "Puppy Programme", amount: 3999, status: "cancelled", start: -3, pay: "created" },
  { id: "UATD-BK-BOARD-1", cus: "UATD-CUS-1", svc: "boarding", provider: "host_maya_rohan", pkg: "Home Boarding · 3 nights", amount: 3600, status: "in_progress", start: -1, pay: "captured" },
  { id: "UATD-BK-BOARD-2", cus: "UATD-CUS-5", svc: "boarding", provider: "host_sana", pkg: "Home Boarding · 2 nights", amount: 2400, status: "confirmed", start: 4, pay: "created" },
  { id: "UATD-BK-SIT-1", cus: "UATD-CUS-2", svc: "pet_sitting", provider: "sit_neha", pkg: "Daily Visit ×3", amount: 1800, status: "completed", start: -8, pay: "captured" },
  { id: "UATD-BK-WALK-1", cus: "UATD-CUS-4", svc: "dog_walking", provider: "walk_nisha", pkg: "30-minute Solo Walk", amount: 698, status: "completed", start: -5, pay: "captured" },
  { id: "UATD-BK-WALK-2", cus: "UATD-CUS-5", svc: "dog_walking", provider: "walk_kiran", pkg: "30-minute Solo Walk", amount: 1047, status: "confirmed", start: 1, pay: "created" },
  { id: "UATD-BK-TAXI-1", cus: "UATD-CUS-3", svc: "pet_taxi", provider: "taxi_rahul", pkg: "Vet Trip · one way", amount: 599, status: "completed", start: -4, pay: "captured" },
  { id: "UATD-BK-TAXI-2", cus: "UATD-CUS-6", svc: "pet_taxi", provider: "taxi_meera", pkg: "Airport Transfer", amount: 1499, status: "confirmed", start: 3, pay: "created" },
  { id: "UATD-BK-GROOM-3", cus: "UATD-CUS-6", svc: "grooming", provider: "groom_arun", pkg: "Full Groom", amount: 1299, status: "completed", start: -95, pay: "captured" }, // lapsed → churn risk
];
for (const b of BOOKINGS) {
  const start = isoAt(b.start, 10), end = isoAt(b.start, 12);
  insert("canonical_bookings", { id: b.id, idempotency_key: `uatd-${b.id}`, customer_id: b.cus, pet_ids_json: JSON.stringify([`${b.cus}-PET`]), source_pet_ids_json: "[]", city_id: "blr", zone_id: "blr-east", service_code: b.svc, package_code: b.svc, package_name: b.pkg, schedule_group_id: `UATD-GRP-${b.id}`, provider_id: b.provider, scheduled_start: start, scheduled_end: end, status: b.status, channel: "customer_app", total_amount: b.amount, currency: "INR", pricing_json: JSON.stringify({ demoSeed: true }), created_by: "uat_demo_seed", created_at: at(b.start - 2), updated_at: at(b.start) });
  insert("booking_payments", { id: `${b.id}-PAY`, booking_id: b.id, customer_id: b.cus, amount: b.amount, amount_due_now: b.pay === "captured" ? b.amount : 0, currency: "INR", method: "upi", mode: "prepaid", status: b.pay, gateway: "uat_sandbox", idempotency_key: `uatd-pay-${b.id}`, detail_json: JSON.stringify({ demoSeed: true }), created_at: at(b.start - 2), updated_at: at(b.start) });
  insert("provider_work_orders", { id: `${b.id}-WO`, booking_id: b.id, schedule_group_id: `UATD-GRP-${b.id}`, provider_id: b.provider, provider_name: b.provider.replace(/_/g, " "), provider_model: b.provider.startsWith("groom_kiran") ? "commission" : "full_time", service_code: b.svc, scheduled_start: start, scheduled_end: end, occurrence_count: 1, status: b.status === "completed" ? "completed" : b.status === "cancelled" ? "cancelled" : "assigned", assignment_json: JSON.stringify({ demoSeed: true }), created_at: at(b.start - 2), updated_at: at(b.start) });
  insert("scheduling_reservations", { id: `${b.id}-RES`, group_id: `UATD-GRP-${b.id}`, provider_id: b.provider, service_code: b.svc, city_id: "blr", zone_id: "blr-east", customer_id: b.cus, pet_ids_json: JSON.stringify([`${b.cus}-PET`]), scheduled_start: start, scheduled_end: end, capacity_units: 1, occurrence_number: 1, care_mode: null, status: b.status === "cancelled" ? "cancelled" : b.status === "completed" ? "completed" : "assigned", explanation_json: "{}", created_at: at(b.start - 2) });
  insert("scheduling_assignment_decisions", { group_id: `UATD-GRP-${b.id}`, strategy: "governed", shortlist_json: "[]", selected_provider_id: b.provider, status: "assigned", actor_id: "uat_demo_seed", reason: "demo seed assignment", updated_at: at(b.start - 2) });
}

// --- ratings (ops-intelligence provider ranking) -----------------------------
for (const [i, b] of BOOKINGS.filter((x) => x.status === "completed").entries()) {
  insert("booking_ratings", { id: `UATD-RATE-${i + 1}`, booking_id: b.id, customer_id: b.cus, provider_id: b.provider, service_code: b.svc, stars: [5, 4, 5, 5, 4, 5][i % 6], comment: "Demo seed rating", created_at: at(b.start + 1) });
}

// --- boarding: host profile + stays (Boarding ops queue) ---------------------
for (const host of ["host_maya_rohan", "host_sana"]) {
  insert("boarding_host_profiles", { provider_id: host, city_id: "blr", zone_id: "blr-east", area: "HSR Layout", species_json: JSON.stringify(["dog", "cat"]), max_guest_pets: 3, one_family_only: 0, medication_support: 1, resident_pets: 1, home_verified: 1, kyc_status: "verified", background_check_status: "verified", active: 1, version: 1, updated_by: "uat_demo_seed", updated_at: at(-60) });
}
insert("boarding_stays", { id: "UATD-STAY-1", booking_id: "UATD-BK-BOARD-1", customer_id: "UATD-CUS-1", host_provider_id: "host_maya_rohan", city_id: "blr", zone_id: "blr-east", package_code: "boarding", check_in_at: isoAt(-1, 10), check_out_at: isoAt(2, 11), billed_units: 3, pet_count: 1, status: "in_progress", care_plan_status: "ready", check_in_status: "complete", check_out_status: "pending", extension_status: "none", created_at: at(-3), updated_at: at(-1) });
insert("boarding_stays", { id: "UATD-STAY-2", booking_id: "UATD-BK-BOARD-2", customer_id: "UATD-CUS-5", host_provider_id: "host_sana", city_id: "blr", zone_id: "blr-east", package_code: "boarding", check_in_at: isoAt(4, 10), check_out_at: isoAt(6, 11), billed_units: 2, pet_count: 1, status: "awaiting_host_acceptance", care_plan_status: "required", check_in_status: "pending", check_out_status: "pending", extension_status: "none", created_at: at(-1), updated_at: at(-1) });

// --- walking sessions (Walking ops queue) ------------------------------------
insert("walking_sessions", { id: "UATD-WALK-1-1", booking_id: "UATD-BK-WALK-1", schedule_group_id: "UATD-GRP-UATD-BK-WALK-1", reservation_id: "UATD-BK-WALK-1-RES", provider_id: "walk_nisha", occurrence_number: 1, scheduled_start: isoAt(-5, 8), scheduled_end: isoAt(-5, 9), status: "completed", handover_status: "complete", completion_status: "complete", created_at: at(-7), updated_at: at(-5) });
insert("walking_sessions", { id: "UATD-WALK-2-1", booking_id: "UATD-BK-WALK-2", schedule_group_id: "UATD-GRP-UATD-BK-WALK-2", reservation_id: "UATD-BK-WALK-2-RES", provider_id: "walk_kiran", occurrence_number: 1, scheduled_start: isoAt(1, 8), scheduled_end: isoAt(1, 9), status: "scheduled", handover_status: "pending", completion_status: "pending", created_at: at(-1), updated_at: at(-1) });

// --- taxi trips (Taxi ops queue) --------------------------------------------
insert("taxi_trips", { id: "UATD-TRIP-1", booking_id: "UATD-BK-TAXI-1", schedule_group_id: "UATD-GRP-UATD-BK-TAXI-1", reservation_id: "UATD-BK-TAXI-1-RES", provider_id: "taxi_rahul", origin_label: "HSR Layout", destination_label: "Cessna Vet Clinic", route_code: "BLR-R1", synthetic_distance_km: 8.4, estimated_duration_minutes: 35, scheduled_start: isoAt(-4, 10), scheduled_end: isoAt(-4, 11), status: "completed", vehicle_id: "TXV-RAHUL-01", pickup_verification_status: "uat_confirmed", dropoff_verification_status: "uat_confirmed", created_at: at(-6), updated_at: at(-4) });
insert("taxi_trips", { id: "UATD-TRIP-2", booking_id: "UATD-BK-TAXI-2", schedule_group_id: "UATD-GRP-UATD-BK-TAXI-2", reservation_id: "UATD-BK-TAXI-2-RES", provider_id: "taxi_meera", origin_label: "Koramangala", destination_label: "Kempegowda Airport", route_code: "BLR-R7", synthetic_distance_km: 38.2, estimated_duration_minutes: 75, scheduled_start: isoAt(3, 6), scheduled_end: isoAt(3, 8), status: "scheduled", vehicle_id: null, pickup_verification_status: "pending", dropoff_verification_status: "pending", created_at: at(-1), updated_at: at(-1) });

// --- people: demo employees, payroll, attendance, leave ----------------------
// Distinct demo emails so they can never collide with employee-seed.sql identities.
const EMPLOYEES = [
  { id: "UATD-EMP-MGR", email: "uat.demo.manager@tkpetcare.in", name: "Demo · Jyoti (Manager)", title: "Sales Manager", team: "sales", manager: null, role: "manager" },
  { id: "UATD-EMP-SALES1", email: "uat.demo.sales1@tkpetcare.in", name: "Demo · Neha (Sales)", title: "Sales Executive", team: "sales", manager: "UATD-EMP-MGR", role: "associate" },
  { id: "UATD-EMP-SALES2", email: "uat.demo.sales2@tkpetcare.in", name: "Demo · Priya (Sales)", title: "Sales Executive", team: "sales", manager: "UATD-EMP-MGR", role: "associate" },
  { id: "UATD-EMP-GROOM", email: "uat.demo.groomer@tkpetcare.in", name: "Demo · Asha (Groomer)", title: "Head Groomer", team: "grooming", manager: "UATD-EMP-MGR", role: "service_provider" },
];
for (const [i, e] of EMPLOYEES.entries()) {
  // app_users makes each demo identity a real staff login (and is the join the performance
  // centre reads employee names from) — without it that report has no user table to join.
  insert("app_users", { id: `${e.id}-USER`, email: e.email, name: e.name, role_code: e.role, status: "active", created_at: at(-400), updated_at: at(-400) });
  insert("employees", { id: e.id, user_email: e.email, employee_code: `UATD-E${i + 1}`, display_name: e.name, work_email: e.email, phone: `98111000${i + 1}`, employment_status: "active", joined_at: at(-400), ended_at: null, created_at: at(-400), updated_at: at(-400) });
  insert("employee_employment_versions", { id: `${e.id}-V1`, employee_id: e.id, version: 1, effective_from: at(-400), effective_until: null, employment_type: "full_time", probation_status: "confirmed", title: e.title, team_code: e.team, manager_employee_id: e.manager, cost_centre_code: `CC-${e.team.toUpperCase()}`, location_code: "BLR", reason: "Demo seed employment record", actor_id: "uat_demo_seed", created_at: at(-400) });
  insert("attendance_days", { id: `${e.id}-ATD-1`, employee_id: e.id, work_date: dateAt(-1), status: "present", first_check_in: at(-1, 9), last_check_out: at(-1, 18), worked_minutes: 540, exception_code: null, source_policy_id: null, updated_at: at(-1) });
  insert("attendance_days", { id: `${e.id}-ATD-2`, employee_id: e.id, work_date: dateAt(-2), status: "present", first_check_in: at(-2, 9), last_check_out: null, worked_minutes: null, exception_code: i === 1 ? "missing_checkout" : null, source_policy_id: null, updated_at: at(-2) });
  insert("employee_leave_balances", { employee_id: e.id, leave_code: "CL", balance: 8, updated_at: at(-30) });
}
insert("leave_requests", { id: "UATD-LVR-1", employee_id: "UATD-EMP-SALES1", leave_code: "CL", start_date: dateAt(5), end_date: dateAt(6), units: 2, reason: "Family function", status: "pending", requested_by: "uat.demo.sales1@tkpetcare.in", approved_by: null, approved_at: null, created_at: at(-1) });
insert("leave_requests", { id: "UATD-LVR-2", employee_id: "UATD-EMP-SALES2", leave_code: "CL", start_date: dateAt(-4), end_date: dateAt(-4), units: 1, reason: "Medical appointment", status: "approved", requested_by: "uat.demo.sales2@tkpetcare.in", approved_by: "uat.demo.manager@tkpetcare.in", approved_at: at(-6), created_at: at(-7) });

// salary structure → compensation → a full payroll run (payslips visible in /me and People reports)
const COMPONENTS = JSON.stringify([{ code: "BASIC", label: "Basic", kind: "earning", amount: 42000 }, { code: "HRA", label: "House rent allowance", kind: "earning", amount: 12000 }, { code: "PF", label: "Provident fund", kind: "deduction", amount: 1800 }]);
insert("salary_structure_versions", { id: "UATD-SAL-1", structure_code: "UATD-STD", version: 1, status: "active_uat", effective_from: at(-365), effective_until: null, currency: "INR", components_json: COMPONENTS, approval_reference: "UATD-APPR-1", created_by: "uat_demo_seed", created_at: at(-365) });
// The run covers the CURRENT month so People reports (which default to month-to-date) show it.
const PAY_START = Date.UTC(2026, 7, 1), PAY_END = Date.UTC(2026, 7, 12, 23, 59, 59);
insert("payroll_runs", { id: "UATD-PAYRUN-1", idempotency_key: "uatd-payrun-1", period_start: PAY_START, period_end: PAY_END, status: "approved", input_snapshot_json: JSON.stringify({ demoSeed: true, statutoryPolicy: "configuration_required" }), created_by: "uat.demo.manager@tkpetcare.in", created_at: at(-12), reviewed_by: "anjali.finance33@tkpetcare.in", reviewed_at: at(-11), approved_by: "founder@pawspace.in", approved_at: at(-10), payment_prepared_at: null });
for (const [i, e] of EMPLOYEES.entries()) {
  insert("employee_compensation_assignments", { id: `${e.id}-ECA`, employee_id: e.id, structure_id: "UATD-SAL-1", effective_from: at(-365), effective_until: null, reason: "Demo seed compensation assignment", actor_id: "uat_demo_seed", created_at: at(-365) });
  const resultId = `UATD-PAYRES-${i + 1}`;
  insert("employee_payroll_results", { id: resultId, run_id: "UATD-PAYRUN-1", employee_id: e.id, structure_id: "UATD-SAL-1", gross_earnings: 54000, total_deductions: 1800, reimbursements: 0, employer_cost: 0, net_pay: 52200, source_snapshot_json: JSON.stringify({ demoSeed: true }) });
  for (const [j, c] of [["BASIC", "Basic", "earning", 42000], ["HRA", "House rent allowance", "earning", 12000], ["PF", "Provident fund", "deduction", 1800]].entries()) {
    insert("payroll_result_lines", { id: `${resultId}-L${j + 1}`, result_id: resultId, component_code: c[0], label: c[1], kind: c[2], amount: c[3], source_type: "salary_structure", source_reference: "UATD-SAL-1", policy_version: "salary_structure:1" });
  }
  insert("payslips", { id: `UATD-PAYSLIP-${i + 1}`, run_id: "UATD-PAYRUN-1", employee_id: e.id, result_id: resultId, status: "available_uat", created_at: at(-10) });
  insert("payroll_approval_events", { id: `UATD-PAEV-${i + 1}`, run_id: "UATD-PAYRUN-1", event_type: i === 0 ? "reviewed" : "approved", actor_id: i === 0 ? "anjali.finance33@tkpetcare.in" : "founder@pawspace.in", detail_json: "{}", created_at: at(-11 + i) });
}

// sales base registry → manager dashboard classifies these two from a GOVERNED registry, not a guess
for (const [i, id] of ["UATD-EMP-SALES1", "UATD-EMP-SALES2"].entries()) {
  insert("sales_employee_base", { id: `UATD-SEB-${i + 1}`, employee_id: EMPLOYEES.find((e) => e.id === id).email, base_vertical: i === 0 ? "training" : "grooming_outbound", effective_from: dateAt(-200), effective_until: null, reason: "Demo seed sales base vertical", actor_id: "uat_demo_seed", created_at: at(-200) });
}

// --- incentives (People → Incentives) ---------------------------------------
insert("incentive_scheme_versions", { id: "UATD-ISV-1", scheme_code: "UATD-SALES-Q3", version: 1, status: "active_uat", role_code: "associate", team_code: "sales", effective_from: at(-120), effective_until: null, formula_json: JSON.stringify({ metric: "net_collected_revenue", target: 50000, payoutType: "percent_of_revenue_above_target", payoutValue: 5, cap: 25000 }), quality_rules_json: JSON.stringify([{ metric: "refunds", operator: "gt", threshold: 3, action: "hold" }]), approval_reference: "UATD-APPR-INC-1", created_by: "uat_demo_seed", created_at: at(-120) });
insert("employee_incentive_periods", { id: "UATD-IPER-1", idempotency_key: "uatd-iper-1", scheme_id: "UATD-ISV-1", period_start: PAY_START, period_end: PAY_END, status: "calculated", calculated_by: "uat.demo.manager@tkpetcare.in", created_at: at(-12) });
insert("employee_incentive_results", { id: "UATD-IRES-1", period_id: "UATD-IPER-1", employee_id: "UATD-EMP-SALES1", employee_email: "uat.demo.sales1@tkpetcare.in", source_fact_run_id: "UATD-SPFR-1", metric_value: 82000, calculated_amount: 1600, approved_amount: 1600, status: "approved", evidence_json: JSON.stringify({ demoSeed: true, metric: "net_collected_revenue" }), approved_by: "founder@pawspace.in", approved_at: at(-9) });
insert("employee_incentive_results", { id: "UATD-IRES-2", period_id: "UATD-IPER-1", employee_id: "UATD-EMP-SALES2", employee_email: "uat.demo.sales2@tkpetcare.in", source_fact_run_id: "UATD-SPFR-1", metric_value: 61000, calculated_amount: 550, approved_amount: 0, status: "calculated", evidence_json: JSON.stringify({ demoSeed: true, metric: "net_collected_revenue" }), approved_by: null, approved_at: null });

// --- productivity facts (leaderboard + performance centre + /me rank) --------
// The one deliberate exception to this file's INSERT OR IGNORE rule. These rows carry load-time
// windows (see LOAD_NOW), and OR IGNORE would keep the ORIGINAL load's timestamps forever, so
// re-running the seed to refresh a stale demo board would silently do nothing. Clearing the two
// UATD-* rows first is what makes a reload actually refresh them. Facts before the run they point
// at; nothing outside the UATD-* namespace is touched, so a real run generated from
// /team/performance survives untouched.
lines.push("DELETE FROM sales_productivity_facts WHERE run_id='UATD-SPFR-1';");
lines.push("DELETE FROM sales_productivity_fact_runs WHERE id='UATD-SPFR-1';");
insert("sales_productivity_fact_runs", { id: "UATD-SPFR-1", idempotency_key: "uatd-spfr-1", policy_id: "UATD-POL-1", policy_version: 1, period_start: LOAD_AGO(7), period_end: LOAD_NOW, status: "completed", source_contract_version: "v1", generated_by: "uat_demo_seed", generated_at: LOAD_NOW, detail_json: JSON.stringify({ demoSeed: true }) });
const FACTS = [
  { email: "uat.demo.sales1@tkpetcare.in", leads: 42, accepted: 40, actions: 128, qualified: 22, clocks: 40, met: 36, breached: 4, conv: 14, booked: 118000, collected: 96000, refunds: 4000, cx: 1 },
  { email: "uat.demo.sales2@tkpetcare.in", leads: 38, accepted: 35, actions: 96, qualified: 17, clocks: 35, met: 28, breached: 7, conv: 9, booked: 84000, collected: 65000, refunds: 4000, cx: 2 },
  { email: "uat.demo.manager@tkpetcare.in", leads: 12, accepted: 12, actions: 40, qualified: 8, clocks: 12, met: 12, breached: 0, conv: 5, booked: 46000, collected: 41000, refunds: 0, cx: 0 },
];
for (const [i, f] of FACTS.entries()) {
  insert("sales_productivity_facts", { id: `UATD-SPF-${i + 1}`, run_id: "UATD-SPFR-1", employee_email: f.email, team_code: "sales", period_start: RUN_PERIOD_START, period_end: RUN_PERIOD_END, leads_assigned: f.leads, assignments_accepted: f.accepted, meaningful_actions: f.actions, qualified_leads: f.qualified, first_response_clocks: f.clocks, first_response_met: f.met, first_response_breached: f.breached, booking_conversions: f.conv, booked_revenue: f.booked, collected_revenue: f.collected, refunds: f.refunds, net_collected_revenue: f.collected - f.refunds, cx_escalations: f.cx, opt_out_or_consent_blocks: 0, data_quality_blocks: 0, quote_count: null, source_detail_json: JSON.stringify({ demoSeed: true }), created_at: RUN_PERIOD_END });
}

// --- CRM: contacts, leads + tickets (CRM engine, cases, customer experience) --
// /api/crm reads crm_contacts DIRECTLY, so without these rows the CRM engine screen showed none of
// the demo customers even though Customer 360 (which merges crm_contacts with canonical_customers)
// showed all six.
//
// lifetime_value is deliberately seeded as 0. The column exists, but /api/crm now RECOMPUTES it from
// each contact's recognised bookings (cancelled and draft excluded) so that the CRM screen and
// Customer 360 report the same money for the same person — a stored figure here would either be
// overwritten or, worse, disagree with the bookings behind it. The demo customers have real bookings,
// so their lifetime value derives itself.
const CRM_STAGES = ["Contacted", "Qualified", "Follow-up", "Won", "Qualified", "Dormant"];
for (const [i, c] of CUSTOMERS.entries()) {
  insert("crm_contacts", { id: `${c.id}-CRM`, name: c.name, primary_phone: c.phone, secondary_phone: null, email: null, area: "HSR Layout", pet_names: c.pet, pet_summary: `${c.pet} · ${c.breed} ${c.species}`, stage: CRM_STAGES[i], owner: ["Neha", "Priya", "Rahul"][i % 3], source: "uat_demo_seed", lifetime_value: 0, next_action: i === 5 ? "Win-back call" : "Rebooking reminder", opportunity: null, created_at: at(-120), updated_at: at(-2 + i * 0.1) });
}

// --- CRM: leads + tickets (CRM engine, cases, customer experience) -----------
const LEADS = [
  { id: "UATD-LEAD-1", cus: "UATD-CUS-1", owner: "Neha", svc: "Grooming", status: "active", stage: "day_1", calls: 2, wa: 1, booking: null },
  { id: "UATD-LEAD-2", cus: "UATD-CUS-2", owner: "Priya", svc: "Boarding", status: "qualified", stage: "day_2", calls: 4, wa: 4, booking: "UATD-BK-GROOM-2" },
  { id: "UATD-LEAD-3", cus: "UATD-CUS-3", owner: "Neha", svc: "Training", status: "converted", stage: "day_3", calls: 3, wa: 2, booking: "UATD-BK-TRAIN-1" },
  { id: "UATD-LEAD-4", cus: "UATD-CUS-6", owner: "Rahul", svc: "Taxi", status: "cold", stage: "day_3", calls: 4, wa: 4, booking: null },
];
for (const l of LEADS) {
  insert("lead_work_items", { id: l.id, customer_id: l.cus, source: "Website", service: l.svc, owner: l.owner, manager: "Sales Manager", status: l.status, stage: l.stage, work_day: 1, assigned_at: at(-3), first_action_due_at: at(-3) + 600_000, manager_alert_at: at(-3) + 1_800_000, first_action_at: at(-3) + 300_000, call_attempts: l.calls, whatsapp_attempts: l.wa, last_outcome: "Demo seed lead", next_action_at: at(1), recycle_at: null, recycle_cycle: 0, opt_out: 0, converted_booking_id: l.booking, created_at: at(-3), updated_at: at(-1) });
}
insert("customer_experience_tickets", { id: "UATD-TKT-1", customer_id: "UATD-CUS-1", booking_id: "UATD-BK-GROOM-1", lead_id: null, category: "Grooming", priority: "high", subject: "Groomer arrived late", detail: "Demo seed ticket: service started 25 minutes after the slot.", owner: "Neha", manager: "Operations Manager", sla_due_at: at(1), status: "open", escalation_level: 1, customer_status: "A manager is reviewing this request", resolution: null, root_cause: null, resolution_evidence: null, reopened_count: 0, created_by: "uat_demo_seed", created_at: at(-2), updated_at: at(-1), resolved_at: null });
insert("customer_experience_tickets", { id: "UATD-TKT-2", customer_id: "UATD-CUS-3", booking_id: "UATD-BK-TAXI-1", lead_id: null, category: "Pet Taxi", priority: "medium", subject: "Pickup address change", detail: "Demo seed ticket: customer moved the pickup point.", owner: "Rahul", manager: "Operations Manager", sla_due_at: at(-3), status: "resolved", escalation_level: 0, customer_status: "Resolved", resolution: "Address updated before pickup.", root_cause: "customer_request", resolution_evidence: "call_log", reopened_count: 1, created_by: "uat_demo_seed", created_at: at(-5), updated_at: at(-4), resolved_at: at(-4) });

// --- AI: configuration, conversations, handoffs, voice, CSAT ----------------
// Produced by executing the real AI libs (scripts/ai-demo-run.mjs) rather than by hand, so every
// value is one the engine can actually emit. Rows still go through insert() below, so the column
// validation that protects the rest of this file protects these too.
const aiRows = await runRealAiDemo({ ddl, customers: CUSTOMERS, bookings: BOOKINGS, now: NOW, isoAt });
for (const [table, row] of aiRows) insert(table, row);
const aiRowCount = aiRows.length;

// --- app-to-revenue funnel ---------------------------------------------------
for (const [i, c] of CUSTOMERS.entries()) {
  insert("app_installs", { install_id: `UATD-INST-${i + 1}`, source: i % 2 ? "play_store" : "app_store", campaign: i % 3 === 0 ? "monsoon_grooming" : null, os: i % 2 ? "android" : "ios", app_version: "1.4.0", first_open_at: at(-20 + i), created_at: at(-20 + i) });
  if (i < 5) insert("install_identity_links", { install_id: `UATD-INST-${i + 1}`, customer_id: c.id, identified_at: at(-19 + i) });
}

// --- finance: ledger, bills, expenses (cash flow, anomalies, compliance) ------
const CASH = "1000-Cash in Hand", BANK = "1010-Bank", REVENUE = "4000-Service Revenue", EXPENSE = "6000-Operating Expense";
const journals = [
  { g: "UATD-JRN-1", period: PREV_MONTH, date: `${PREV_MONTH}-12`, cash: BANK, amount: 48000, counter: REVENUE, narration: "July collections (demo seed)" },
  { g: "UATD-JRN-2", period: MONTH, date: `${MONTH}-05`, cash: BANK, amount: 62000, counter: REVENUE, narration: "August collections (demo seed)" },
  { g: "UATD-JRN-3", period: MONTH, date: `${MONTH}-07`, cash: BANK, amount: -18500, counter: EXPENSE, narration: "Vendor payments (demo seed)" },
];
for (const j of journals) {
  const inflow = j.amount >= 0;
  insert("finance_journal_entries", { id: `${j.g}-1`, entry_date: j.date, source_type: "collection", source_id: j.g, account_code: j.cash, cost_centre: "CC-OPS", vertical: "grooming", debit: inflow ? j.amount : 0, credit: inflow ? 0 : -j.amount, narration: j.narration, period_code: j.period, posted: 1, created_at: at(-15) });
  insert("finance_journal_entries", { id: `${j.g}-2`, entry_date: j.date, source_type: "collection", source_id: j.g, account_code: j.counter, cost_centre: "CC-OPS", vertical: "grooming", debit: inflow ? 0 : -j.amount, credit: inflow ? j.amount : 0, narration: j.narration, period_code: j.period, posted: 1, created_at: at(-15) });
}
// one deliberately UNBALANCED journal so Finance intelligence has a real anomaly to show
insert("finance_journal_entries", { id: "UATD-JRN-BAD-1", entry_date: `${MONTH}-09`, source_type: "manual", source_id: "UATD-JRN-BAD", account_code: EXPENSE, cost_centre: "CC-OPS", vertical: "grooming", debit: 5000, credit: 0, narration: "Demo seed: deliberately unbalanced journal (anomaly demo)", period_code: MONTH, posted: 1, created_at: at(-4) });
insert("finance_journal_entries", { id: "UATD-JRN-BAD-2", entry_date: `${MONTH}-09`, source_type: "manual", source_id: "UATD-JRN-BAD", account_code: CASH, cost_centre: "CC-OPS", vertical: "grooming", debit: 0, credit: 4500, narration: "Demo seed: deliberately unbalanced journal (anomaly demo)", period_code: MONTH, posted: 1, created_at: at(-4) });
// bills: a duplicate pair and an outlier, so the anomaly report is not empty
const bills = [
  { id: "UATD-BILL-1", vendor: "UATD-VENDOR-SUPPLY", no: "SUP-1001", date: `${MONTH}-02`, amount: 12000 },
  { id: "UATD-BILL-2", vendor: "UATD-VENDOR-SUPPLY", no: "SUP-1002", date: `${MONTH}-05`, amount: 12000 },
  { id: "UATD-BILL-3", vendor: "UATD-VENDOR-TRANSPORT", no: "TRN-201", date: `${MONTH}-01`, amount: 3000 },
  { id: "UATD-BILL-4", vendor: "UATD-VENDOR-TRANSPORT", no: "TRN-202", date: `${MONTH}-04`, amount: 3200 },
  { id: "UATD-BILL-5", vendor: "UATD-VENDOR-TRANSPORT", no: "TRN-203", date: `${MONTH}-08`, amount: 2900 },
  { id: "UATD-BILL-6", vendor: "UATD-VENDOR-TRANSPORT", no: "TRN-204", date: `${MONTH}-11`, amount: 26000 },
];
for (const b of bills) {
  insert("finance_bills", { id: b.id, vendor_id: b.vendor, bill_number: b.no, bill_date: b.date, due_date: dateAt(20), cost_centre: "CC-OPS", vertical: "grooming", taxable_amount: Math.round(b.amount / 1.18), gst_amount: b.amount - Math.round(b.amount / 1.18), tds_amount: 0, total_amount: b.amount, status: "approved", purchase_order_id: null, attachment_reference: null, created_at: at(-10), updated_at: at(-10) });
}
for (const [i, e] of [["Arun K", "Indian Oil", "fuel", 2400], ["Neha S", "Amazon", "supplies", 1850], ["Asha R", "Uber", "travel", 640]].entries()) {
  insert("finance_expenses", { id: `UATD-EXP-${i + 1}`, expense_date: dateAt(-5 + i), claimant: e[0], merchant: e[1], category: e[2], cost_centre: "CC-OPS", vertical: "grooming", amount: e[3], gst_amount: 0, payment_mode: "upi", receipt_reference: `UATD-RCPT-${i + 1}`, status: "approved", duplicate_risk: 0, created_at: at(-5 + i), updated_at: at(-5 + i) });
}

// --- partner economics: commercial terms + computed payouts (+ TDS basis) ----
insert("provider_commercial_terms", { id: "UATD-PCT-GROOM", service_code: "grooming", provider_id: null, version: 1, status: "active", engagement_model: "commission_groomer", provider_share_pct: 0.7, gst_mode: "none", platform_gst_rate: 0.18, cash_allowed: 1, onboarding_fee: 0, renewal_fee: 0, renewal_months: 12, effective_from: dateAt(-200), reason: "Demo seed grooming commercial baseline", created_by: "uat_demo_seed", approved_by: "founder@pawspace.in", approval_reference: "UATD-APPR-PCT-1", created_at: at(-200), updated_at: at(-200) });
insert("provider_commercial_terms", { id: "UATD-PCT-STD", service_code: "dog_walking", provider_id: null, version: 1, status: "active", engagement_model: "commission_standard", provider_share_pct: 0.7, gst_mode: "provider_gst_on_behalf", platform_gst_rate: 0.18, cash_allowed: 0, onboarding_fee: 0, renewal_fee: 0, renewal_months: 12, effective_from: dateAt(-200), reason: "Demo seed walking commercial baseline", created_by: "uat_demo_seed", approved_by: "founder@pawspace.in", approval_reference: "UATD-APPR-PCT-2", created_at: at(-200), updated_at: at(-200) });
for (const b of BOOKINGS.filter((x) => x.status === "completed" && ["grooming", "dog_walking"].includes(x.svc))) {
  const groomer = b.svc === "grooming";
  const gross = Math.round(b.amount * 0.7 * 100) / 100;
  const gstDeducted = groomer ? 0 : Math.round(b.amount * 0.18 * 100) / 100;
  const platformFee = Math.round((b.amount - gross) * 100) / 100;
  insert("provider_payout_computations", { booking_id: b.id, provider_id: b.provider, service_code: b.svc, order_value: b.amount, provider_net_payout: Math.round((gross - gstDeducted) * 100) / 100, platform_fee: platformFee, platform_gst: Math.round(platformFee * 0.18 * 100) / 100, provider_gst_deducted: gstDeducted, pawspace_gst_on_order: 0, breakdown_json: JSON.stringify({ demoSeed: true, providerSharePct: 0.7 }), term_id: groomer ? "UATD-PCT-GROOM" : "UATD-PCT-STD", computed_by: "uat_demo_seed", computed_at: at(b.start + 1) });
}
// identity links so the partner workspace and self-service resolve a real subject
insert("provider_identity_links", { email: "uat.demo.groomer@tkpetcare.in", provider_id: "groom_arun", status: "active", verified_at: at(-100), updated_at: at(-100) });
insert("customer_identity_links", { email: "uat.demo.customer@tkpetcare.in", customer_id: "UATD-CUS-1", status: "active", verified_at: at(-100), updated_at: at(-100) });
// a live job offer so the partner workspace has something to accept
insert("provider_job_offers", { id: "UATD-OFFER-1", provider_id: "groom_arun", booking_id: "UATD-BK-GROOM-2", status: "offered", offered_at: at(-1), responded_at: null, expires_at: at(2), detail_json: JSON.stringify({ demoSeed: true }) });

// --- pet care records (growth intelligence: vaccination due + birthday) ------
insert("pet_vaccinations", { id: "UATD-VAX-1", pet_id: "UATD-CUS-1-PET", customer_id: "UATD-CUS-1", vaccine_type: "rabies", administered_on: dateAt(-350), next_due_on: dateAt(9), administered_by: "Dr Rao", notes: "Demo seed record", status: "active", created_at: at(-350), updated_at: at(-350) });
insert("pet_vaccinations", { id: "UATD-VAX-2", pet_id: "UATD-CUS-6-PET", customer_id: "UATD-CUS-6", vaccine_type: "DHPPi", administered_on: dateAt(-400), next_due_on: dateAt(-20), administered_by: "Dr Rao", notes: "Demo seed record: overdue", status: "active", created_at: at(-400), updated_at: at(-400) });
insert("pet_birthdays", { pet_id: "UATD-CUS-2-PET", customer_id: "UATD-CUS-2", date_of_birth: `2023-${dateAt(6).slice(5)}`, created_at: at(-100), updated_at: at(-100) });

// ---------------------------------------------------------------------------
// 3b. Sales performance + governed campaigns (merged from #158).
// ---------------------------------------------------------------------------
// These rows layer on scripts/staging-seed.sql: they reference its customers (CUS0000...) and bookings
// (BK00000...) by design, so the sales and marketing screens are measured against the same volume the
// rest of staging carries. Load the staging seed first, as docs/STAGING_DEPLOY.md instructs.
//
// Kept on #158's own base date rather than this file's `NOW`, so the leads still land inside the 7, 30
// and 90-day windows the leaderboard offers and the numbers its tests assert stay the numbers.
const SALES_BASE = Date.UTC(2026, 7, 1);

// ------------------------------------------------------------------------------------ sales team
const REPS = [
  { email: "asha.rao@pawspace.in", name: "Asha Rao", leads: 9, qualified: 5, converted: 3 },
  { email: "vikram.shetty@pawspace.in", name: "Vikram Shetty", leads: 7, qualified: 4, converted: 2 },
  { email: "neha.kulkarni@pawspace.in", name: "Neha Kulkarni", leads: 6, qualified: 2, converted: 2 },
  { email: "rohit.menon@pawspace.in", name: "Rohit Menon", leads: 5, qualified: 1, converted: 1 },
];
const AMOUNTS = [799, 1299, 699, 899, 599];
let leadSeq = 0, bookingSeq = 0;

lines.push("-- Sales team: reps, their team membership, and the lead work the leaderboard measures.");
for (const [repIndex, rep] of REPS.entries()) {
  insert("app_users", { id: `USR-SALES-${repIndex}`, email: rep.email, name: rep.name, role_code: "associate", status: "active", created_at: SALES_BASE - 120 * DAY, updated_at: SALES_BASE - 120 * DAY });
  insert("lead_assignment_memberships", {
    id: `LAM-SALES-${repIndex}`, employee_email: rep.email, team_code: "sales",
    service_codes_json: JSON.stringify(["grooming", "boarding", "dog_training"]), city_ids_json: JSON.stringify(["blr", "hyd"]),
    language_codes_json: JSON.stringify(["en", "hi"]), active: 1, workload_cap_override: null,
    created_by: "uat-demo-seed", created_at: SALES_BASE - 120 * DAY, updated_by: "uat-demo-seed", updated_at: SALES_BASE - 120 * DAY,
  });

  for (let index = 0; index < rep.leads; index += 1) {
    const leadId = `LEAD-UAT-${String(leadSeq).padStart(4, "0")}`;
    const assignmentId = `ASG-UAT-${String(leadSeq).padStart(4, "0")}`;
    const clockId = `CLK-UAT-${String(leadSeq).padStart(4, "0")}`;
    const customerId = `CUS${String(leadSeq * 3 % 220).padStart(4, "0")}`;
    // Spread the work across the last three weeks so 7/30/90-day windows all show something.
    const at = SALES_BASE - (3 + (leadSeq % 18)) * DAY;
    const qualified = index < rep.qualified;
    const converted = index < rep.converted;
    const bookingId = converted ? `BK${String(bookingSeq++).padStart(5, "0")}` : null;
    const amount = AMOUNTS[leadSeq % AMOUNTS.length];
    const metSla = index % 3 !== 2;

    insert("lead_work_items", {
      id: leadId, customer_id: customerId, source: ["website", "whatsapp", "referral"][index % 3], service: ["grooming", "boarding", "dog_training"][index % 3],
      owner: rep.email, manager: "sales.manager@pawspace.in", status: converted ? "converted" : "active", stage: "day_1", work_day: 1,
      assigned_at: at, first_action_due_at: at + 600000, manager_alert_at: at + 1_800_000, first_action_at: at + 300000,
      call_attempts: 1 + (index % 3), whatsapp_attempts: index % 2, last_outcome: qualified ? "qualified" : "call_back_later",
      next_action_at: at + 2 * DAY, recycle_at: null, recycle_cycle: 0, opt_out: 0, converted_booking_id: bookingId,
      created_at: at, updated_at: at + 3 * DAY,
    });
    insert("lead_assignments", {
      id: assignmentId, idempotency_key: `${assignmentId}-idem`, lead_id: leadId, employee_email: rep.email, team_code: "sales",
      policy_id: "LAP-UAT-DEMO", policy_version: 1, assignment_reason: "round_robin", status: "current", fallback_queue: null,
      assigned_at: at, accepted_at: at + 120000, ended_at: null, ended_reason: null, previous_assignment_id: null,
      detail_json: "{}", created_by: "uat-demo-seed", created_at: at,
    });
    insert("lead_sla_clocks", {
      id: clockId, idempotency_key: `${clockId}-idem`, lead_id: leadId, assignment_id: assignmentId, policy_id: "LSP-UAT-DEMO", policy_version: 1,
      clock_type: "first_response", cycle: 1, status: metSla ? "met" : "breached", started_at: at, due_at: at + 600000,
      manager_escalation_due_at: at + 1_800_000, reassignment_due_at: at + 3_600_000, met_at: metSla ? at + 300000 : null,
      breached_at: metSla ? null : at + 900000, paused_at: null, pause_reason: null, paused_remaining_minutes: null,
      last_action_at: at + 300000, next_action_at: at + 2 * DAY, detail_json: "{}", created_by: "uat-demo-seed", created_at: at, updated_at: at + 300000,
    });
    // Every touch is a recorded action; its outcome is what makes the lead "qualified" under a policy.
    for (const [actionIndex, actionType] of ["call", "whatsapp"].entries()) {
      const eventId = `EVT-UAT-${String(leadSeq).padStart(4, "0")}-${actionIndex}`;
      insert("lead_sla_events", {
        id: eventId, idempotency_key: `${eventId}-idem`, clock_id: clockId, lead_id: leadId, event_type: "action_recorded", actor_id: rep.email,
        detail_json: JSON.stringify({ actionType, outcome: actionIndex === 0 && qualified ? "qualified" : converted ? "booked" : "call_back_later" }),
        created_at: at + 300000 + actionIndex * 60000,
      });
    }
    if (converted) {
      // Money for a converted lead comes from the revenue ledger, keyed to the booking.
      insert("revenue_mission_events", {
        id: `RME-UAT-${leadSeq}-c`, mission_id: "MIS-UAT-DEMO", source_event_key: `${bookingId}-collected`, event_type: "collected",
        customer_id: customerId, booking_id: bookingId, payment_id: `PAY-${bookingId}`, refund_id: null, service_code: "grooming", city_id: "blr",
        gross_amount: amount, refund_amount: 0, eligible_amount: amount, currency: "INR", source_at: at + 2 * DAY,
        source_version: "uat_demo_seed:v1", attribution_json: "{}", created_at: at + 2 * DAY,
      });
      if (leadSeq % 7 === 0) {
        insert("revenue_mission_events", {
          id: `RME-UAT-${leadSeq}-r`, mission_id: "MIS-UAT-DEMO", source_event_key: `${bookingId}-refunded`, event_type: "refunded",
          customer_id: customerId, booking_id: bookingId, payment_id: `PAY-${bookingId}`, refund_id: `RFD-${bookingId}`, service_code: "grooming", city_id: "blr",
          gross_amount: 0, refund_amount: Math.round(amount / 2), eligible_amount: 0, currency: "INR", source_at: at + 3 * DAY,
          source_version: "uat_demo_seed:v1", attribution_json: "{}", created_at: at + 3 * DAY,
        });
      }
    }
    leadSeq += 1;
  }
}

// An active policy so the leaderboard has a definition to measure against. The fact run is deliberately
// left out: generating it is one click on /team/performance, which is also how the pipeline is proven.
lines.push("-- Active productivity policy. Generate the report from /team/performance to fill the board.");
insert("sales_productivity_policies", {
  id: "SPP-UAT-DEMO", name: "Sales productivity (UAT baseline)", status: "active_uat", version: 1, team_code: "sales", timezone: "Asia/Kolkata",
  meaningful_action_types_json: JSON.stringify(["call", "whatsapp"]), qualified_outcomes_json: JSON.stringify(["qualified", "booked"]),
  revenue_basis: "net_collected", require_canonical_lead_booking_link: 1, effective_from: SALES_BASE - 365 * DAY, effective_until: null,
  approval_reference: "UAT-DEMO-SEED", created_by: "uat-demo-seed", created_at: SALES_BASE - 120 * DAY, updated_by: "uat-demo-seed", updated_at: SALES_BASE - 120 * DAY,
});

// -------------------------------------------------------------------------------------- marketing
lines.push("-- Governed campaigns: one live with a taken audience snapshot, one awaiting approval.");
const CAMPAIGNS = [
  { id: "CMP-UAT-MONSOON", name: "Monsoon grooming refresh", objective: "reactivation", service: "grooming", city: "blr", budget: 45000, holdout: 10, status: "active", approval: "approved" },
  { id: "CMP-UAT-BOARDING", name: "Festive boarding pre-book", objective: "acquisition", service: "boarding", city: "hyd", budget: 60000, holdout: 15, status: "draft", approval: "approval_required" },
];
for (const campaign of CAMPAIGNS) {
  insert("governed_marketing_campaigns", {
    id: campaign.id, name: campaign.name, objective: campaign.objective, service_code: campaign.service, city_id: campaign.city,
    audience_rule_json: JSON.stringify({ marketingConsent: true, serviceCode: campaign.service, cityId: campaign.city }),
    budget_amount: campaign.budget, currency: "INR", holdout_percent: campaign.holdout, status: campaign.status, approval_status: campaign.approval,
    approved_by: campaign.approval === "approved" ? "marketing.head@pawspace.in" : null, approved_at: campaign.approval === "approved" ? SALES_BASE - 20 * DAY : null,
    start_at: campaign.status === "active" ? SALES_BASE - 18 * DAY : null, end_at: campaign.status === "active" ? SALES_BASE + 12 * DAY : null,
    created_by: "uat-demo-seed", created_at: SALES_BASE - 25 * DAY, updated_at: SALES_BASE - 18 * DAY,
  });
}

// The snapshot mirrors what snapshotCampaignAudience() records: consent-eligible customers, an explicit
// holdout, and everyone else suppressed with the reason they were held back.
const live = CAMPAIGNS[0];
const audience = [];
for (let index = 0; index < 220; index += 3) audience.push(`CUS${String(index).padStart(4, "0")}`);
const holdout = audience.filter((_, index) => index % 10 === 0);
const suppressed = audience.filter((_, index) => index % 7 === 0 && index % 10 !== 0);
const eligible = audience.filter((id) => !holdout.includes(id) && !suppressed.includes(id));
insert("marketing_audience_snapshots", {
  id: "MAS-UAT-MONSOON", campaign_id: live.id, snapshot_at: SALES_BASE - 18 * DAY, total_candidates: audience.length,
  eligible_count: eligible.length, holdout_count: holdout.length, suppressed_count: suppressed.length,
  policy_json: JSON.stringify({ requiresMarketingConsent: true, holdoutPercent: live.holdout, suppressionReasons: ["marketing_consent_missing"] }),
  created_by: "uat-demo-seed",
});
for (const customerId of audience) {
  const cohort = holdout.includes(customerId) ? "holdout" : suppressed.includes(customerId) ? "suppressed" : "eligible";
  insert("marketing_audience_members", {
    snapshot_id: "MAS-UAT-MONSOON", campaign_id: live.id, customer_id: customerId, cohort,
    suppression_reason: cohort === "suppressed" ? "marketing_consent_missing" : null,
  });
}

// Attribution facts carry the spend the unit-economics CAC line refuses to invent.
for (let index = 0; index < 6; index += 1) {
  const bookingId = `BK${String(index).padStart(5, "0")}`;
  insert("marketing_attribution_facts", {
    id: `MAF-UAT-${index}`, campaign_id: live.id, customer_id: `CUS${String(index * 3).padStart(4, "0")}`, lead_id: null, booking_id: bookingId,
    collection_id: null, source: "meta", medium: "paid_social", spend_amount: 1500, booked_revenue: AMOUNTS[index % AMOUNTS.length],
    collected_revenue: AMOUNTS[index % AMOUNTS.length], contribution_margin: null, attribution_model: "last_touch_uat",
    created_at: SALES_BASE - 15 * DAY, updated_at: SALES_BASE - 15 * DAY,
  });
}


// ---------------------------------------------------------------------------
// 4. Write the file: real DDL first (only for tables actually used), then rows.
// ---------------------------------------------------------------------------
// A kill switch is deliberately absent (nothing is disabled), so it is the one AI table allowed to
// be empty. Every other one must have produced rows, or the AI screens would open empty again.
for (const table of AI_TABLES) {
  if (table === "ai_kill_switches") continue;
  if (!usedTables.has(table)) throw new Error(`AI demo run produced no rows for '${table}' — the AI surfaces would open empty`);
}

const header = [
  "-- PawSpace UAT DEMO SEED (generated by scripts/uat-demo-seed-gen.mjs — do not hand-edit).",
  "-- Puts real, derivable demo data behind every module UI so no staging page opens empty.",
  "-- Every CREATE TABLE below is copied verbatim from the source file that owns it.",
  "-- All rows carry a UATD marker and are inserted with INSERT OR IGNORE: safe to re-run,",
  "-- and it never collides with staging-seed.sql or employee-seed.sql.",
  "--",
  "-- The AI rows were written by the REAL AI engine (scripts/ai-demo-run.mjs runs the same libs the",
  "-- product runs), which is why their IDs carry the engine's own prefixes. The AI replies come from",
  "-- a declared scripted provider recorded as provider='uat_demo_scripted' on every turn — no row",
  "-- here is output from a live model. The rollout stage is seeded to 'staff_only': the assistant",
  "-- answers the internal team, customers still reach a human until someone widens it on",
  "-- /team/ai/rollout.",
  `-- Demo 'today' is ${dateAt(0)}.`,
  "",
];
const creates = [...usedTables].sort().map((t) => `${ddl.get(t).sql};`);
fs.writeFileSync("scripts/uat-demo-seed.sql", [...header, ...creates, "", ...lines, ""].join("\n"));
console.log(`scripts/uat-demo-seed.sql written: ${creates.length} tables, ${lines.filter((l) => l.startsWith("INSERT")).length} rows (${aiRowCount} from the real AI engine).`);
