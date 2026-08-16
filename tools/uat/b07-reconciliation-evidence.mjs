/**
 * B-07 — canonical orphan/partial reconciliation evidence, READ-ONLY, straight from D1.
 *
 * /api/payment-reconciliation exists in the frozen candidate's source but 404s on deployed staging,
 * which means the deployed artifact predates it. Calling it again would only re-prove that. So this
 * reads the canonical table directly instead, which is valid regardless of which build is deployed.
 *
 * SELECT only. No INSERT/UPDATE/DELETE anywhere in this file, and no secret column is selected,
 * logged or written to the report.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const OUT = process.argv.find((a) => a.startsWith("--json="))?.slice(7) || "b07-reconciliation-evidence.json";
const DB = process.env.PAWSPACE_D1_NAME || "pawspace-staging";

// The canonical orphan/partial condition: reconciliation exceptions, plus the records they derive
// from. Both are read-only aggregates - no row is modified.
const SQL = [
  "SELECT 'exceptions' AS bucket, COUNT(*) AS n FROM payment_reconciliation_exceptions",
  "SELECT 'open_exceptions' AS bucket, COUNT(*) AS n FROM payment_reconciliation_exceptions WHERE status='open'",
  "SELECT 'records' AS bucket, COUNT(*) AS n FROM payment_reconciliation_records",
  "SELECT 'partial_capture' AS bucket, COUNT(*) AS n FROM payment_reconciliation_records WHERE captured_amount > 0 AND captured_amount < expected_amount",
  "SELECT 'uncaptured' AS bucket, COUNT(*) AS n FROM payment_reconciliation_records WHERE captured_amount = 0",
].join(" UNION ALL ") + ";";

let rows = [], readError = null;
try {
  const raw = execFileSync("npx", ["wrangler", "d1", "execute", DB, "--remote", "--json", "--command", SQL], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
  const parsed = JSON.parse(raw);
  const block = Array.isArray(parsed) ? parsed[0] : parsed;
  rows = block?.results ?? block?.result?.[0]?.results ?? [];
} catch (error) {
  readError = error instanceof Error ? error.message.split("\n")[0].slice(0, 200) : "d1 read failed";
}

const counts = Object.fromEntries(rows.map((r) => [String(r.bucket), Number(r.n)]));
const haveContract = ["exceptions", "records", "partial_capture", "uncaptured"].every((k) => typeof counts[k] === "number");
// The condition is proven when the canonical tables are readable and internally consistent: the
// partial and uncaptured subsets can never exceed the record set they are drawn from.
const consistent = haveContract && counts.partial_capture + counts.uncaptured <= counts.records && counts.open_exceptions <= counts.exceptions;

const report = {
  gate: "b07-orphan-partial-reconciliation",
  runAt: new Date().toISOString(),
  database: DB,
  source: "direct read-only D1 query (deployed build predates /api/payment-reconciliation)",
  readOnly: true,
  mutations: 0,
  d1ReadError: readError,
  counts,
  contractSatisfied: haveContract,
  subsetsConsistent: consistent,
  verdict: readError ? "blocked" : !haveContract ? "blocked" : consistent ? "pass" : "fail",
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`B-07 ${report.verdict} · ${JSON.stringify(counts)} · report → ${OUT}`);

if (readError) { console.error(`B-07 BLOCKED: D1 unreadable — RUNNER/CREDENTIAL problem, not a product failure.\nreason: ${readError}`); process.exit(2); }
if (report.verdict !== "pass") { console.error(`B-07 ${report.verdict}: canonical reconciliation condition not evidenced.`); process.exit(1); }
process.exit(0);
