/**
 * GATE 0 — live identity preflight. READ-ONLY. Mutates nothing.
 *
 * Every downstream gate depends on a specific persona actually existing and being active on staging.
 * Without this check, a missing row surfaces later as a 403 that looks like a product authorization
 * failure. That misattribution is the specific thing this gate exists to prevent: if an identity is
 * absent, the run must stop here and say so, rather than let a seeding gap be recorded as a product
 * defect.
 *
 * Reads staging D1 through `wrangler d1 execute --remote --json` with a single SELECT. The query
 * returns only email, role_code, status and provider_id — no secret, token, cookie or session
 * material is selected, logged or written to the report.
 *
 * Fails closed: any missing row, inactive status or wrong provider mapping exits non-zero.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const OUT = process.argv.find((a) => a.startsWith("--json="))?.slice(7) || "gate0-identity-report.json";
const DB = process.env.PAWSPACE_D1_NAME || "pawspace-staging";

/** The exact personas the corrected matrix requires, and what each is used for downstream. */
const REQUIRED = [
  { email: "anita.associate17@tkpetcare.in", role: "associate", usedFor: "ownership-sensitive POSTs (must NOT hold customers.manage/bookings.manage, or the ownership guard is bypassed)" },
  { email: "sunita.manager37@tkpetcare.in", role: "manager", usedFor: "privileged before/after reads; Journey C cancellation requester (scheduling.book)" },
  { email: "anjali.finance33@tkpetcare.in", role: "finance", usedFor: "Journey C approver (finance.manage); B-07 reconciliation (finance.view)" },
  { email: "asha.groomer1@tkpetcare.in", role: "service_provider", usedFor: "Journey D cross-provider negative", provider: "groom_arun" },
  { email: "rahul.groomer2@tkpetcare.in", role: "service_provider", usedFor: "Journey D positive (UATD-BK-GROOM-2-WO)", provider: "groom_kiran" },
];

const emails = REQUIRED.map((r) => `'${r.email}'`).join(",");
const SQL = `SELECT u.email, u.role_code, u.status, l.provider_id, l.status AS link_status FROM app_users u LEFT JOIN provider_identity_links l ON l.email = u.email WHERE u.email IN (${emails});`;

function readD1() {
  // --json keeps the output machine-readable; the SELECT above carries no secret columns.
  const raw = execFileSync("npx", ["wrangler", "d1", "execute", DB, "--remote", "--json", "--command", SQL], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000,
  });
  const parsed = JSON.parse(raw);
  const block = Array.isArray(parsed) ? parsed[0] : parsed;
  return block?.results ?? block?.result?.[0]?.results ?? [];
}

let rows = [];
let readError = null;
try {
  rows = readD1();
} catch (error) {
  // Never echo the raw error: wrangler can include account identifiers in diagnostics.
  readError = error instanceof Error ? error.message.split("\n")[0].slice(0, 200) : "d1 read failed";
}

const byEmail = new Map(rows.map((r) => [String(r.email).toLowerCase(), r]));
const checks = REQUIRED.map((req) => {
  const row = byEmail.get(req.email.toLowerCase());
  if (!row) return { ...req, present: false, ok: false, reason: "no app_users row on staging" };
  const activeUser = String(row.status) === "active";
  const roleOk = String(row.role_code) === req.role;
  const providerOk = req.provider ? String(row.provider_id || "") === req.provider && String(row.link_status || "") === "active" : true;
  return {
    email: req.email, usedFor: req.usedFor, present: true,
    role: String(row.role_code), roleExpected: req.role, roleOk,
    status: String(row.status), activeUser,
    providerId: row.provider_id ?? null, providerExpected: req.provider ?? null,
    linkStatus: row.link_status ?? null, providerOk,
    ok: activeUser && roleOk && providerOk,
    reason: !activeUser ? "user not active" : !roleOk ? "unexpected role" : !providerOk ? "provider link missing/inactive/mismatched" : null,
  };
});

const missing = checks.filter((c) => !c.ok);
const report = {
  gate: "gate0-identity-preflight",
  runAt: new Date().toISOString(),
  database: DB,
  readOnly: true,
  mutationsPerformed: 0,
  d1ReadError: readError,
  checks,
  summary: { required: REQUIRED.length, satisfied: checks.filter((c) => c.ok).length, missing: missing.map((m) => ({ email: m.email, reason: m.reason })) },
  verdict: readError ? "blocked" : missing.length ? "fail" : "pass",
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

for (const c of checks) console.log(`${c.ok ? "OK     " : "MISSING"} ${c.email} (${c.roleExpected}${c.providerExpected ? ` → ${c.providerExpected}` : ""})`);
console.log(`\ngate 0 → ${report.verdict} · ${report.summary.satisfied}/${REQUIRED.length} identities · report → ${OUT}`);

if (readError) {
  console.error(`\nGATE 0 BLOCKED: staging D1 could not be read. This is a RUNNER/CREDENTIAL problem, not a product failure.`);
  console.error(`reason: ${readError}`);
  process.exit(2);
}
if (missing.length) {
  console.error(`\nGATE 0 FAILED: required identities absent or inactive on staging.`);
  console.error(`This is a SEEDING gap, not a product defect — re-run seed-staging.yml with the staff-directory step.`);
  for (const m of missing) console.error(`  - ${m.email}: ${m.reason}`);
  process.exit(1);
}
process.exit(0);
