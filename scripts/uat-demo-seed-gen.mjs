// Generates scripts/uat-demo-seed.sql — a deterministic, re-runnable demo layer that puts REAL,
// derivable data behind EVERY module UI, so no staging page opens empty.
//
// It complements (never replaces) the two existing seeds:
//   scripts/staging-seed.sql   — 220 customers / ~307 bookings (volume)
//   scripts/employee-seed.sql  — the salaried employee + payroll/tax baseline
// This one adds the module-level rows those two don't carry: service lifecycle (stays, walk
// sessions, taxi trips), AI conversations, app funnel, productivity facts, attendance/leave,
// incentives, ledger + bills + expenses, commercial terms + payouts, ratings, vaccinations,
// birthdays, CRM leads/tickets and provider identity links.
//
// SAFETY: every CREATE TABLE is COPIED VERBATIM from the source file that owns it (never retyped),
// and every column name used in an INSERT is validated against that real DDL — the generator throws
// rather than emit a statement referencing a column that does not exist. All rows are namespaced
// `UATD-*` and written with INSERT OR IGNORE, so the script is safe to re-run and never collides
// with the other seeds.
//
// Run:   node scripts/uat-demo-seed-gen.mjs
// Load:  npx wrangler d1 execute pawspace-staging --remote --file=scripts/uat-demo-seed.sql

import fs from "node:fs";

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
  "lib/communication-engine.ts",
  "lib/app-to-revenue-funnel.ts",
  "lib/gst-accounting.ts",
  "lib/people-finance-integration.ts",
  "lib/booking-rating.ts",
  "lib/pet-vaccination-governance.ts",
  "lib/pet-birthday-governance.ts",
  "app/api/walking-bookings/route.ts",
  "app/api/revenue-crm/route.ts",
  "app/api/uat-scheduling/route.ts",
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

const q = (v) => {
  if (v === null || v === undefined) return "NULL";
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
insert("sales_productivity_fact_runs", { id: "UATD-SPFR-1", idempotency_key: "uatd-spfr-1", policy_id: "UATD-POL-1", policy_version: 1, period_start: at(-30), period_end: at(0), status: "completed", source_contract_version: "v1", generated_by: "uat_demo_seed", generated_at: at(-1), detail_json: JSON.stringify({ demoSeed: true }) });
const FACTS = [
  { email: "uat.demo.sales1@tkpetcare.in", leads: 42, accepted: 40, actions: 128, qualified: 22, clocks: 40, met: 36, breached: 4, conv: 14, booked: 118000, collected: 96000, refunds: 4000, cx: 1 },
  { email: "uat.demo.sales2@tkpetcare.in", leads: 38, accepted: 35, actions: 96, qualified: 17, clocks: 35, met: 28, breached: 7, conv: 9, booked: 84000, collected: 65000, refunds: 4000, cx: 2 },
  { email: "uat.demo.manager@tkpetcare.in", leads: 12, accepted: 12, actions: 40, qualified: 8, clocks: 12, met: 12, breached: 0, conv: 5, booked: 46000, collected: 41000, refunds: 0, cx: 0 },
];
for (const [i, f] of FACTS.entries()) {
  insert("sales_productivity_facts", { id: `UATD-SPF-${i + 1}`, run_id: "UATD-SPFR-1", employee_email: f.email, team_code: "sales", period_start: at(-30), period_end: at(0), leads_assigned: f.leads, assignments_accepted: f.accepted, meaningful_actions: f.actions, qualified_leads: f.qualified, first_response_clocks: f.clocks, first_response_met: f.met, first_response_breached: f.breached, booking_conversions: f.conv, booked_revenue: f.booked, collected_revenue: f.collected, refunds: f.refunds, net_collected_revenue: f.collected - f.refunds, cx_escalations: f.cx, opt_out_or_consent_blocks: 0, data_quality_blocks: 0, quote_count: null, source_detail_json: JSON.stringify({ demoSeed: true }), created_at: at(-1) });
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

// --- AI: threads, turns, handoffs, voice, CSAT, delivery --------------------
for (const [i, c] of CUSTOMERS.slice(0, 3).entries()) {
  insert("communication_threads", { id: `UATD-TH-${i + 1}`, customer_id: c.id, booking_id: BOOKINGS[i].id, lead_id: null, ticket_id: null, status: "open", assigned_to: null, sla_due_at: at(1), created_at: at(-2), updated_at: at(-1) });
}
const TURNS = [
  { id: "UATD-TURN-1", th: "UATD-TH-1", cus: "UATD-CUS-1", ch: "whatsapp", intent: "booking_status", outcome: "answered", latency: 620, in: 140, out: 90, cost: 3 },
  { id: "UATD-TURN-2", th: "UATD-TH-1", cus: "UATD-CUS-1", ch: "whatsapp", intent: "reschedule", outcome: "handoff", latency: 880, in: 180, out: 120, cost: 5 },
  { id: "UATD-TURN-3", th: "UATD-TH-2", cus: "UATD-CUS-2", ch: "chat", intent: "pricing", outcome: "answered", latency: 410, in: 100, out: 70, cost: 2 },
  { id: "UATD-TURN-4", th: "UATD-TH-3", cus: "UATD-CUS-3", ch: "chat", intent: "vaccination_help", outcome: "answered", latency: 540, in: 130, out: 85, cost: 3 },
  { id: "UATD-TURN-5", th: "UATD-TH-3", cus: "UATD-CUS-3", ch: "voice", intent: "booking_status", outcome: "answered", latency: 750, in: 160, out: 110, cost: 4 },
];
for (const [i, t] of TURNS.entries()) {
  insert("ai_conversation_turns", { id: t.id, session_id: `UATD-SES-${t.th}`, thread_id: t.th, customer_id: t.cus, input_message_id: `UATD-MSG-${i + 1}`, idempotency_key: `uatd-turn-${i + 1}`, channel: t.ch, intent_code: t.intent, intent_confidence: 0.92, context_id: `UATD-CTX-${i + 1}`, provider: "uat_sandbox", model_ref: null, output_text: "Demo seed AI response.", latency_ms: t.latency, input_tokens: t.in, output_tokens: t.out, cost_minor: t.cost, policy_decision: "allowed", outcome: t.outcome, handoff_reason: t.outcome === "handoff" ? "customer_requested_human" : null, created_at: at(-2 + i * 0.1), completed_at: at(-2 + i * 0.1) + t.latency });
}
insert("ai_handoffs", { id: "UATD-HO-1", thread_id: "UATD-TH-1", customer_id: "UATD-CUS-1", session_id: "UATD-SES-UATD-TH-1", reason: "customer_requested_human", confidence: 0.41, queue_code: "care", status: "taken_over", summary_json: JSON.stringify({ demoSeed: true }), requested_by: "ai", taken_over_by: "uat.demo.manager@tkpetcare.in", resumed_by: null, created_at: at(-2), taken_over_at: at(-2) + 240_000, resumed_at: null });
insert("ai_voice_calls", { id: "UATD-VOICE-1", thread_id: "UATD-TH-3", customer_id: "UATD-CUS-3", transport_provider: "uat_sandbox", direction: "inbound", status: "completed", consent_status: "granted", language: "en-IN", started_at: at(-2, 11), ended_at: at(-2, 11) + 180_000, outcome: "answered", disposition: "resolved_by_ai", live_agent_transfer: 0, reconnect_count: 0, created_by: "uat_demo_seed" });
lines.push("CREATE TABLE IF NOT EXISTS ai_explicit_csat (id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,customer_id TEXT NOT NULL,rating INTEGER NOT NULL,source TEXT NOT NULL,created_at INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5));");
lines.push(`INSERT OR IGNORE INTO ai_explicit_csat (id,thread_id,customer_id,rating,source,created_at) VALUES ('UATD-CSAT-1','UATD-TH-1','UATD-CUS-1',4,'post_chat_survey',${at(-1)});`);
lines.push(`INSERT OR IGNORE INTO ai_explicit_csat (id,thread_id,customer_id,rating,source,created_at) VALUES ('UATD-CSAT-2','UATD-TH-3','UATD-CUS-3',5,'post_chat_survey',${at(-1)});`);

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
// 4. Write the file: real DDL first (only for tables actually used), then rows.
// ---------------------------------------------------------------------------
const header = [
  "-- PawSpace UAT DEMO SEED (generated by scripts/uat-demo-seed-gen.mjs — do not hand-edit).",
  "-- Puts real, derivable demo data behind every module UI so no staging page opens empty.",
  "-- Every CREATE TABLE below is copied verbatim from the source file that owns it.",
  "-- All rows are namespaced UATD-* and inserted with INSERT OR IGNORE: safe to re-run,",
  "-- and it never collides with staging-seed.sql or employee-seed.sql.",
  `-- Demo 'today' is ${dateAt(0)}.`,
  "",
];
const creates = [...usedTables].sort().map((t) => `${ddl.get(t).sql};`);
fs.writeFileSync("scripts/uat-demo-seed.sql", [...header, ...creates, "", ...lines, ""].join("\n"));
console.log(`scripts/uat-demo-seed.sql written: ${creates.length} tables, ${lines.filter((l) => l.startsWith("INSERT")).length} rows.`);
