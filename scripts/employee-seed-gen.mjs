// Generates scripts/employee-seed.sql — a deterministic, re-runnable D1 seed for human UAT of the
// people/payroll/incentive/leaderboard modules and the GST invoicing module. Produces:
//   - 40 test employees (+ app_users so they can sign into /me) across groomers, trainers, sales,
//     ops, finance and managers, each on a banded salary structure with a compensation assignment
//   - ONE approved Aug-2026 payroll run with per-employee results, payslip lines and payslips
//   - Sales base verticals + a few daily-incentive inputs, a groomer bracket/target, a trainer
//     conversion — so the live leaderboard and daily-incentive accrual have real data to rank
//   - The legal entity TK PETCARE SOLUTIONS PRIVATE LIMITED (GSTIN 29AAICT7352F1Z0, Jayanagar,
//     Bengaluru 560041) with a GST policy and 12 sample tax invoices (CGST 9% + SGST 9%)
// Uses EXACT production table schemas (CREATE TABLE IF NOT EXISTS) and INSERT OR IGNORE so it is safe
// to run whether the app or the seed goes first, and safe to re-run. Fixed timestamps → identical output.
// Run:   node scripts/employee-seed-gen.mjs
// Load:  npx wrangler d1 execute pawspace-staging --remote --file=scripts/employee-seed.sql
import { writeFileSync } from "node:fs";

const money = (v) => Math.round(Number(v || 0) * 100) / 100;
const q = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const BASE = Date.UTC(2026, 7, 1);            // 2026-08-01
const PERIOD_START = Date.UTC(2026, 7, 1);
const PERIOD_END = Date.UTC(2026, 7, 31, 23, 59, 59);
const JOINED = Date.UTC(2024, 0, 15);
const s = [];

// ---- Company / GST identity (from the founder) ----
const COMPANY = {
  legalName: "TK PETCARE SOLUTIONS PRIVATE LIMITED",
  gstin: "29AAICT7352F1Z0",
  stateCode: "29", state: "Karnataka",
  address: "2nd Floor, No. 07/3, 15/1, 185/2, 185/A, Kokarya Business Synergy Center, Nagananda Commercial Complex, 18th Main Road, Jayanagar 9th Block, Bengaluru, Karnataka 560041",
};

// ---- Salary bands (monthly INR). Components split BASIC/HRA/SPECIAL; PF+PT deductions; employer PF cost. ----
const BANDS = {
  groomer:   { structure: "band-groomer",   gross: 22000, role: "service_provider", team: "grooming" },
  trainer:   { structure: "band-trainer",   gross: 30000, role: "service_provider", team: "training" },
  associate: { structure: "band-associate", gross: 25000, role: "associate",        team: "sales" },
  ops:       { structure: "band-ops",       gross: 20000, role: "associate",        team: "operations" },
  finance:   { structure: "band-finance",   gross: 40000, role: "finance",          team: "finance" },
  manager:   { structure: "band-manager",   gross: 55000, role: "manager",          team: "management" },
};
function components(gross) {
  const basic = money(gross * 0.6), hra = money(gross * 0.3), special = money(gross - basic - hra);
  const pf = money(Math.min(basic, 15000) * 0.12), pt = 200;               // employee PF capped at ₹15k wage; professional tax
  const employerPf = money(Math.min(basic, 15000) * 0.12);
  return {
    lines: [
      { code: "BASIC", label: "Basic", kind: "earning", amount: basic },
      { code: "HRA", label: "House rent allowance", kind: "earning", amount: hra },
      { code: "SPECIAL", label: "Special allowance", kind: "earning", amount: special },
      { code: "PF_EE", label: "Provident fund (employee)", kind: "deduction", amount: pf },
      { code: "PT", label: "Professional tax", kind: "deduction", amount: pt },
      { code: "PF_ER", label: "Provident fund (employer)", kind: "employer_cost", amount: employerPf },
    ],
    gross: money(basic + hra + special),
    deductions: money(pf + pt),
    employerCost: employerPf,
  };
}

// ---- 40 employees ----
const NAMES = ["Asha","Rahul","Priya","Sanjay","Neha","Vikram","Divya","Arjun","Meena","Kiran","Sneha","Ravi","Pooja","Amit","Kavya","Suresh","Anita","Manoj","Deepa","Raj","Swathi","Naveen","Lakshmi","Girish","Bhavya","Harish","Nisha","Prakash","Rekha","Vinod","Shruti","Ganesh","Anjali","Mahesh","Preeti","Rohit","Sunita","Karthik","Jyoti","Vishal"];
const PLAN = [
  ...Array(10).fill("groomer"), ...Array(6).fill("trainer"), ...Array(10).fill("associate"),
  ...Array(6).fill("ops"), ...Array(4).fill("finance"), ...Array(4).fill("manager"),
];
const employees = PLAN.map((band, i) => {
  const code = `EMP${String(i + 1).padStart(3, "0")}`;
  const name = `${NAMES[i]} ${String.fromCharCode(65 + (i % 26))}.`;
  const email = `${NAMES[i].toLowerCase()}.${band}${i + 1}@tkpetcare.in`;
  return { id: `SEEDEMP-${code}`, code, name, email, band, ...BANDS[band] };
});

// ---- Schema (exact production DDL) ----
s.push("-- PawSpace employee + payroll + GST UAT seed (generated). Safe to re-run.");
s.push("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role_code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);");
s.push("CREATE TABLE IF NOT EXISTS employees (id TEXT PRIMARY KEY,user_email TEXT UNIQUE,employee_code TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL,work_email TEXT NOT NULL UNIQUE,phone TEXT,employment_status TEXT NOT NULL DEFAULT 'active',joined_at INTEGER,ended_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);");
s.push("CREATE TABLE IF NOT EXISTS salary_structure_versions (id TEXT PRIMARY KEY,structure_code TEXT NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'draft',effective_from INTEGER NOT NULL,effective_until INTEGER,currency TEXT NOT NULL DEFAULT 'INR',components_json TEXT NOT NULL,approval_reference TEXT,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(structure_code,version));");
s.push("CREATE TABLE IF NOT EXISTS employee_compensation_assignments (id TEXT PRIMARY KEY,employee_id TEXT NOT NULL,structure_id TEXT NOT NULL,effective_from INTEGER NOT NULL,effective_until INTEGER,reason TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL);");
s.push("CREATE TABLE IF NOT EXISTS payroll_runs (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,period_start INTEGER NOT NULL,period_end INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'draft',input_snapshot_json TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,reviewed_by TEXT,reviewed_at INTEGER,approved_by TEXT,approved_at INTEGER,payment_prepared_at INTEGER);");
s.push("CREATE TABLE IF NOT EXISTS employee_payroll_results (id TEXT PRIMARY KEY,run_id TEXT NOT NULL,employee_id TEXT NOT NULL,structure_id TEXT NOT NULL,gross_earnings REAL NOT NULL,total_deductions REAL NOT NULL,reimbursements REAL NOT NULL,employer_cost REAL NOT NULL,net_pay REAL NOT NULL,source_snapshot_json TEXT NOT NULL,UNIQUE(run_id,employee_id));");
s.push("CREATE TABLE IF NOT EXISTS payroll_result_lines (id TEXT PRIMARY KEY,result_id TEXT NOT NULL,component_code TEXT NOT NULL,label TEXT NOT NULL,kind TEXT NOT NULL,amount REAL NOT NULL,source_type TEXT NOT NULL,source_reference TEXT,policy_version TEXT NOT NULL);");
s.push("CREATE TABLE IF NOT EXISTS payslips (id TEXT PRIMARY KEY,run_id TEXT NOT NULL,employee_id TEXT NOT NULL,result_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'available_uat',created_at INTEGER NOT NULL,UNIQUE(run_id,employee_id));");
s.push("CREATE TABLE IF NOT EXISTS sales_employee_base (id TEXT PRIMARY KEY,employee_id TEXT NOT NULL,base_vertical TEXT NOT NULL,effective_from TEXT NOT NULL,effective_until TEXT,reason TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL);");
s.push("CREATE TABLE IF NOT EXISTS sales_attributed_bookings (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,employee_id TEXT NOT NULL,recorded_by TEXT NOT NULL,recorded_at INTEGER NOT NULL);");
s.push("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);");
s.push("CREATE TABLE IF NOT EXISTS groomer_incentive_brackets (id TEXT PRIMARY KEY,head_groomer_id TEXT NOT NULL,bracket TEXT NOT NULL,helper_id TEXT,effective_from TEXT NOT NULL,effective_until TEXT,reason TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL);");
s.push("CREATE TABLE IF NOT EXISTS groomer_monthly_targets (id TEXT PRIMARY KEY,head_groomer_id TEXT NOT NULL,month_start TEXT NOT NULL,target_amount REAL NOT NULL,reason TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(head_groomer_id,month_start));");
s.push("CREATE TABLE IF NOT EXISTS trainer_meet_greet_conversions (id TEXT PRIMARY KEY,trainer_id TEXT NOT NULL,meet_greet_booking_id TEXT NOT NULL UNIQUE,converted_booking_id TEXT NOT NULL UNIQUE,converted_order_value REAL NOT NULL,incentive_amount REAL NOT NULL,recorded_by TEXT NOT NULL,recorded_at INTEGER NOT NULL);");
s.push("CREATE TABLE IF NOT EXISTS finance_entities (id TEXT PRIMARY KEY,legal_name TEXT NOT NULL,country_code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',approved_by TEXT,approved_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);");
s.push("CREATE TABLE IF NOT EXISTS tax_registrations (id TEXT PRIMARY KEY,entity_id TEXT NOT NULL,jurisdiction TEXT NOT NULL,registration_type TEXT NOT NULL,registration_reference TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',effective_from TEXT,effective_to TEXT,approved_by TEXT,approved_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);");
s.push("CREATE TABLE IF NOT EXISTS tax_policy_versions (id TEXT PRIMARY KEY,entity_id TEXT NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'draft',effective_from TEXT NOT NULL,effective_to TEXT,policy_json TEXT NOT NULL,approval_reference TEXT,approved_by TEXT,approved_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(entity_id,version));");
s.push("CREATE TABLE IF NOT EXISTS tax_classifications (id TEXT PRIMARY KEY,policy_id TEXT NOT NULL,service_code TEXT NOT NULL,classification_code TEXT NOT NULL,tax_component_json TEXT NOT NULL,place_of_supply_rule TEXT NOT NULL,input_tax_rule TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(policy_id,service_code));");
s.push("CREATE TABLE IF NOT EXISTS finance_invoices (id TEXT PRIMARY KEY,invoice_number TEXT NOT NULL UNIQUE,entity_id TEXT NOT NULL,customer_id TEXT NOT NULL,source_type TEXT NOT NULL,source_id TEXT NOT NULL,source_event_key TEXT NOT NULL UNIQUE,policy_id TEXT NOT NULL,registration_id TEXT NOT NULL,issue_date TEXT NOT NULL,currency TEXT NOT NULL,subtotal REAL NOT NULL,tax_total REAL NOT NULL,total REAL NOT NULL,status TEXT NOT NULL DEFAULT 'issued',tax_snapshot_json TEXT NOT NULL,document_reference TEXT,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(source_type,source_id));");
s.push("CREATE TABLE IF NOT EXISTS finance_invoice_lines (id TEXT PRIMARY KEY,invoice_id TEXT NOT NULL,line_key TEXT NOT NULL,description TEXT NOT NULL,service_code TEXT NOT NULL,taxable_amount REAL NOT NULL,tax_amount REAL NOT NULL,tax_snapshot_json TEXT NOT NULL,UNIQUE(invoice_id,line_key));");

// ---- Platform-owner identity for UAT sign-in ----
// founder@pawspace.in is offered as the "Founder (full access)" identity on /staging-login and in
// docs/UAT-TESTER-GUIDE.md, but it is the OWNER identity, not an employee on a payroll band, so the
// employee loop below never created it. UAT sign-in (lib/uat-staging-auth.ts) requires an ACTIVE
// app_users row whose role has a definition; without this row the advertised Founder identity could
// never sign in. Its role is 'founder' (permissions ["*"] via defaultRoles) — a real seeded active
// row, exactly like every other staff identity here. Nothing is synthesised.
s.push(`INSERT OR IGNORE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (${q("SEEDUSR-FOUNDER")},${q("founder@pawspace.in")},'PawSpace Founder','founder','active',${JOINED},${BASE});`);

// ---- Salary structures (one per band) ----
const structures = {};
Object.entries(BANDS).forEach(([band, cfg]) => {
  const c = components(cfg.gross);
  const id = `SEEDSAL-${cfg.structure}`;
  structures[band] = { id, version: 1, comp: c };
  s.push(`INSERT OR IGNORE INTO salary_structure_versions (id,structure_code,version,status,effective_from,currency,components_json,approval_reference,created_by,created_at) VALUES (${q(id)},${q(cfg.structure)},1,'active_uat',${JOINED},'INR',${q(JSON.stringify(c.lines))},'SEED-APPROVAL',${q("founder@pawspace.in")},${BASE});`);
});

// ---- One approved Aug-2026 payroll run ----
const RUN = "SEEDRUN-AUG2026";
s.push(`INSERT OR IGNORE INTO payroll_runs (id,idempotency_key,period_start,period_end,status,input_snapshot_json,created_by,created_at,reviewed_by,reviewed_at,approved_by,approved_at) VALUES (${q(RUN)},'seed-payroll-aug-2026',${PERIOD_START},${PERIOD_END},'approved','{"seed":true,"period":"2026-08"}',${q("hr@pawspace.in")},${BASE},${q("finance@pawspace.in")},${BASE},${q("founder@pawspace.in")},${BASE});`);

// ---- Employees + app_users + compensation + payroll results/lines/payslips ----
for (const e of employees) {
  s.push(`INSERT OR IGNORE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (${q("SEEDUSR-" + e.code)},${q(e.email)},${q(e.name)},${q(e.role)},'active',${JOINED},${BASE});`);
  s.push(`INSERT OR IGNORE INTO employees (id,user_email,employee_code,display_name,work_email,phone,employment_status,joined_at,created_at,updated_at) VALUES (${q(e.id)},${q(e.email)},${q(e.code)},${q(e.name)},${q(e.email)},'0000000000','active',${JOINED},${JOINED},${BASE});`);
  const st = structures[e.band];
  s.push(`INSERT OR IGNORE INTO employee_compensation_assignments (id,employee_id,structure_id,effective_from,reason,actor_id,created_at) VALUES (${q("SEEDECA-" + e.code)},${q(e.id)},${q(st.id)},${JOINED},'Seeded standard band compensation for UAT',${q("hr@pawspace.in")},${BASE});`);
  const c = st.comp, net = money(c.gross - c.deductions);
  const resultId = `SEEDRES-${e.code}`;
  const snapshot = JSON.stringify({ employeeId: e.id, structureId: st.id, seed: true });
  s.push(`INSERT OR IGNORE INTO employee_payroll_results (id,run_id,employee_id,structure_id,gross_earnings,total_deductions,reimbursements,employer_cost,net_pay,source_snapshot_json) VALUES (${q(resultId)},${q(RUN)},${q(e.id)},${q(st.id)},${c.gross},${c.deductions},0,${c.employerCost},${net},${q(snapshot)});`);
  for (const [li, line] of c.lines.entries())
    s.push(`INSERT OR IGNORE INTO payroll_result_lines (id,result_id,component_code,label,kind,amount,source_type,source_reference,policy_version) VALUES (${q(`SEEDLINE-${e.code}-${li}`)},${q(resultId)},${q(line.code)},${q(line.label)},${q(line.kind)},${line.amount},'salary_structure',${q(st.id)},'salary_structure:1');`);
  s.push(`INSERT OR IGNORE INTO payslips (id,run_id,employee_id,result_id,status,created_at) VALUES (${q("SEEDSLIP-" + e.code)},${q(RUN)},${q(e.id)},${q(resultId)},'available_uat',${BASE});`);
}

// ---- Sales base verticals for the 10 associates (so daily incentive + employee leaderboard work) ----
const salesEmployees = employees.filter((e) => e.band === "associate");
const verticals = ["training", "grooming_outbound", "grooming_inbound", "grooming_both"];
salesEmployees.forEach((e, i) => {
  s.push(`INSERT OR IGNORE INTO sales_employee_base (id,employee_id,base_vertical,effective_from,reason,actor_id,created_at) VALUES (${q("SEEDSEB-" + e.code)},${q(e.id)},${q(verticals[i % verticals.length])},'2026-08-01','Seeded sales base vertical for UAT leaderboard',${q("manager@pawspace.in")},${BASE});`);
});

// ---- A groomer bracket + monthly target (so the groomer leaderboard ranks) ----
const groomers = employees.filter((e) => e.band === "groomer").slice(0, 3);
groomers.forEach((g, i) => {
  s.push(`INSERT OR IGNORE INTO groomer_incentive_brackets (id,head_groomer_id,bracket,effective_from,reason,actor_id,created_at) VALUES (${q("SEEDGB-" + g.code)},${q(g.id)},${q(i === 0 ? "single" : "team")},'2026-08-01','Seeded groomer bracket for UAT',${q("manager@pawspace.in")},${BASE});`);
  s.push(`INSERT OR IGNORE INTO groomer_monthly_targets (id,head_groomer_id,month_start,target_amount,reason,actor_id,created_at) VALUES (${q("SEEDGT-" + g.code)},${q(g.id)},'2026-08-01',${120000 + i * 20000},'Seeded monthly target for UAT',${q("manager@pawspace.in")},${BASE});`);
});

// ---- A trainer conversion with self-contained bookings (so the trainer leaderboard ranks) ----
const trainer = employees.find((e) => e.band === "trainer");
if (trainer) {
  const mg = "SEEDBK-MG1", conv = "SEEDBK-CV1";
  const mk = (id, svc, pkg, pkgName, amount, day, status) =>
    `INSERT OR IGNORE INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (${q(id)},${q("idem-" + id)},'SEEDCUS1','[]','[]','blr','blr-east',${q(svc)},${q(pkg)},${q(pkgName)},${q("sg-" + id)},${q(trainer.id)},'2026-08-${day}T10:00:00','2026-08-${day}T11:00:00',${q(status)},'customer_app',${amount},'INR','{}',${q("manager@pawspace.in")},${BASE},${BASE});`;
  s.push(mk(mg, "dog_training", "trainer-meet-greet", "Trainer Meet & Greet", 0, "05", "completed"));
  s.push(mk(conv, "dog_training", "training-8week", "8-week training programme", 18000, "07", "completed"));
  s.push(`INSERT OR IGNORE INTO trainer_meet_greet_conversions (id,trainer_id,meet_greet_booking_id,converted_booking_id,converted_order_value,incentive_amount,recorded_by,recorded_at) VALUES (${q("SEEDTMG1")},${q(trainer.id)},${q(mg)},${q(conv)},18000,1000,${q("manager@pawspace.in")},${BASE});`);
}

// ---- GST legal entity + registration + policy + classifications ----
const ENTITY = "SEEDFE-TKPET", REG = "SEEDTR-TKPET-KA", POLICY = "SEEDTP-TKPET-1";
s.push(`INSERT OR IGNORE INTO finance_entities (id,legal_name,country_code,status,approved_by,approved_at,created_at,updated_at) VALUES (${q(ENTITY)},${q(COMPANY.legalName)},'IN','active',${q("founder@pawspace.in")},${BASE},${BASE},${BASE});`);
s.push(`INSERT OR IGNORE INTO tax_registrations (id,entity_id,jurisdiction,registration_type,registration_reference,status,effective_from,approved_by,approved_at,created_at,updated_at) VALUES (${q(REG)},${q(ENTITY)},${q("IN-KA")},'gstin',${q(COMPANY.gstin)},'active','2024-01-01',${q("founder@pawspace.in")},${BASE},${BASE},${BASE});`);
const policyJson = JSON.stringify({ seller: COMPANY, defaultComponents: [{ code: "CGST", rate: 9 }, { code: "SGST", rate: 9 }] });
s.push(`INSERT OR IGNORE INTO tax_policy_versions (id,entity_id,version,status,effective_from,policy_json,approval_reference,approved_by,approved_at,created_at,updated_at) VALUES (${q(POLICY)},${q(ENTITY)},1,'active','2024-01-01',${q(policyJson)},'SEED-GST-APPROVAL',${q("founder@pawspace.in")},${BASE},${BASE},${BASE});`);
const SERVICES = ["grooming", "dog_training", "boarding", "pet_sitting", "dog_walking", "pet_taxi"];
const comps = JSON.stringify([{ code: "CGST", rate: 9 }, { code: "SGST", rate: 9 }]);
SERVICES.forEach((svc, i) => {
  s.push(`INSERT OR IGNORE INTO tax_classifications (id,policy_id,service_code,classification_code,tax_component_json,place_of_supply_rule,input_tax_rule,created_at) VALUES (${q("SEEDTC-" + svc)},${q(POLICY)},${q(svc)},${q("SAC-9985-" + i)},${q(comps)},'buyer_state','standard',${BASE});`);
});

// ---- 12 sample GST tax invoices (CGST 9% + SGST 9%) ----
const PRICES = [799, 1299, 699, 399, 599, 1499, 899, 2499, 999, 1799, 499, 3499];
for (let i = 0; i < 12; i++) {
  const svc = SERVICES[i % SERVICES.length], taxable = PRICES[i], tax = money(taxable * 0.18);
  const total = money(taxable + tax), invId = `SEEDINV-${String(i + 1).padStart(3, "0")}`;
  const invNo = `TKP/2026-27/${String(i + 1).padStart(4, "0")}`;
  const day = String(2 + i).padStart(2, "0"), issueDate = `2026-08-${day}`;
  const snap = JSON.stringify({ seller: COMPANY, buyer: { name: `UAT Customer ${i + 1}`, stateCode: "29" }, placeOfSupply: "29-Karnataka", components: [{ code: "CGST", rate: 9, amount: money(tax / 2) }, { code: "SGST", rate: 9, amount: money(tax / 2) }] });
  s.push(`INSERT OR IGNORE INTO finance_invoices (id,invoice_number,entity_id,customer_id,source_type,source_id,source_event_key,policy_id,registration_id,issue_date,currency,subtotal,tax_total,total,status,tax_snapshot_json,document_reference,created_by,created_at) VALUES (${q(invId)},${q(invNo)},${q(ENTITY)},${q("SEEDCUS" + (i + 1))},'booking',${q("seed-src-" + invId)},${q("seed-evt-" + invId)},${q(POLICY)},${q(REG)},${q(issueDate)},'INR',${taxable},${tax},${total},'issued',${q(snap)},${q(invNo)},${q("finance@pawspace.in")},${BASE});`);
  s.push(`INSERT OR IGNORE INTO finance_invoice_lines (id,invoice_id,line_key,description,service_code,taxable_amount,tax_amount,tax_snapshot_json) VALUES (${q(invId + "-L1")},${q(invId)},'L1',${q(svc + " service (UAT sample)")},${q(svc)},${taxable},${tax},${q(comps)});`);
}

s.push(`-- Generated ${employees.length} employees, 1 approved payroll run with payslips, and 12 GST invoices for ${COMPANY.legalName} (${COMPANY.gstin}).`);
writeFileSync(new URL("./employee-seed.sql", import.meta.url), s.join("\n") + "\n");
console.log(`employee-seed.sql written: ${employees.length} employees, ${s.filter((l) => l.startsWith("INSERT")).length} INSERT statements.`);
