import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";

// T4 is an objective-level gate over executable D1 suites. Every case receives an isolated case
// ledger, while each owning check creates its own fresh D1-compatible database. The demo seed is never
// opened or changed. Provider references in this pack are visibly contract-test references only.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exact = value => `^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
function runCheck(file, name) { const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", "--test-name-pattern", exact(name), file], { cwd: root, encoding: "utf8", timeout: 120_000, env: { ...process.env, PAWSPACE_FORCE_LOADER_HOOK: "0" } }); return { file, name, status: result.status, signal: result.signal, stdout: result.stdout || "", stderr: result.stderr || "", error: result.error?.message || null }; }

const cases = [
  ["076", "sandbox order creation contract", [["tests/payment-provider-contract.test.mjs", "external Razorpay contract: accepted order and payment-link responses preserve exact binding"]]],
  ["077", "post-service payment-link creation", [["tests/post-service-payment-link.test.mjs", "post-service collection creates a bound, non-partial Razorpay sandbox link"], ["tests/post-service-payment-link.test.mjs", "post-service expiry is provider-bound, persisted, and an expired request cannot remain collectable"], ["tests/payment-provider-contract.test.mjs", "external Razorpay contract: invalid provider responses are rejected"]]],
  ["078", "raw signed webhook verification", [["tests/money-hardening.test.mjs", "real execution: webhook refuses unsigned/badly-signed/unconfigured requests before touching any state"]]],
  ["079", "captured payment", [["tests/money-hardening.test.mjs", "real execution: verify-first — a 'created' payment is only captured by a correctly signed webhook, reconciliation matches booking_payments exactly, duplicates ignored"]]],
  ["080", "failed payment", [["tests/finance-money-decomposition.test.mjs", "NEGATIVE: a failed payment collects nothing"]]],
  ["081", "duplicate and out-of-order gateway events", [["tests/split-payment-capture-idempotency.test.mjs", "cases 1-3: payment.captured + order.paid for ONE payment collect once, with no exception"], ["tests/split-payment-capture-idempotency.test.mjs", "case 4: a fresh event id for the same underlying capture is still idempotent"]]],
  ["082", "amount, customer, booking, order and currency binding", [["tests/payment-order-cross-customer-runtime.test.mjs", "customer cannot open a payment order for another customer's booking"], ["tests/split-payment-capture-settlement.test.mjs", "a capture that disagrees with its own order is still an exception, per stage"], ["tests/grooming-payment-reconciliation.test.mjs", "Grooming payment integration is sandbox-locked signed idempotent and reconciled"]]],
  ["083", "full refund", [["tests/money-hardening.test.mjs", "real execution: capture amount mismatch and refund flow both land in the exact reconciliation truth"]]],
  ["084", "partial refund and collected-funds ceiling", [["tests/finance-money-decomposition.test.mjs", "partial refund keeps all four measures distinct"], ["tests/refund-cap-collected-funds.test.mjs", "the booking total is not the refund ceiling in any service"]]],
  ["085", "unmatched gateway event", [["tests/money-hardening.test.mjs", "real execution: payment-reconciliation console lists webhook exceptions and dismisses them with a governed note"]]],
  ["086", "booked, collected, refunded and net decomposition", [["tests/finance-money-decomposition.test.mjs", "prepaid and captured: booked equals collected, refunded is zero, net equals collected"], ["tests/revenue-stack-hardening.test.mjs", "real execution: mission booked/collected/refunded derive exactly from seeds — cancelled and draft bookings never count"]]],
  ["087", "invoice numbering and immutable replay", [["tests/gst-accounting-uat.test.mjs", "gate 2 provides immutable idempotent invoice truth with allocated numbering"], ["tests/finance-statutory-execution.test.mjs", "invoice replay preserves immutable tax-ledger row identity and repeated service lines"]]],
  ["088", "GST ledger and eligible input tax", [["tests/statutory-finance-close.test.mjs", "monthly close aggregates real revenue/GST/TDS, blocks without board approval, then locks"], ["tests/gst-accounting-uat.test.mjs", "gate 5 creates tax ledger, review package, maker-checker and supersession"]]],
  ["089", "balanced double-entry journal", [["tests/payroll-finance-execution.test.mjs", "an approved payroll run posts a balanced journal sourced to that run"], ["tests/finance-control-truth.test.mjs", "NEGATIVE: an unbalanced ledger is reported as unbalanced"]]],
  ["090", "expense and vendor-bill governance", [["tests/finance-control-truth.test.mjs", "every rendered finance figure is counted from the rows, not asserted"], ["tests/finance-filing-closeout.test.mjs", "finance mutations use authenticated actors and precheck locked periods"]]],
  ["091", "Finance maker cannot self-approve", [["tests/finance-statutory-execution.test.mjs", "NEGATIVE: the maker cannot approve their own package, and the refusal changes nothing"]]],
  ["092", "checker approval requires evidence", [["tests/finance-statutory-execution.test.mjs", "NEGATIVE: a checker without an approval reference is refused, and the package stays draft"]]],
  ["093", "correction, reversal and credit note without deletion", [["tests/gst-accounting-uat.test.mjs", "gate 3 uses linked bounded immutable credit and debit notes"], ["tests/incentive-engine.test.mjs", "finalized incentive corrections are new adjustment or reversal events instead of history edits"], ["tests/finance-statutory-execution.test.mjs", "invoice replay preserves immutable tax-ledger row identity and repeated service lines"]]],
  ["094", "accounting export checksum and replay", [["tests/finance-statutory-execution.test.mjs", "regenerating an identical export is deterministic and creates no second run"], ["tests/finance-statutory-execution.test.mjs", "an accounting export contains only the requested entity, period, posted lines and approved mapping"]]],
  ["095", "payroll calculation and approval", [["tests/payroll-engine.test.mjs", "payroll calculation is idempotent and snapshots source configuration"], ["tests/payroll-engine.test.mjs", "maker checker prevents payroll creator or reviewer from approving own run"], ["tests/payroll-finance-execution.test.mjs", "NEGATIVE: an unapproved payroll run cannot be posted to Finance"]]],
  ["096", "payroll to configured Finance accounts only", [["tests/payroll-finance-execution.test.mjs", "NEGATIVE: an unconfigured mapping fails closed and writes no journal"], ["tests/payroll-finance-execution.test.mjs", "an approved payroll run posts a balanced journal sourced to that run"]]],
  ["097", "incentive inclusion, reversal and partner settlement", [["tests/incentive-hardening.test.mjs", "approved incentives reach payroll exactly once and reversals become deductions"], ["tests/people-partner-hardening.test.mjs", "partner workspace earnings reconcile with provider_payout_computations; commission providers see no earnings"], ["tests/incentive-engine.test.mjs", "incentive calculation consumes canonical productivity facts and excludes pipeline revenue"]]],
  ["098", "failed bank transmission never marks paid", [["tests/payroll-finance-execution.test.mjs", "NEGATIVE: a mismatched amount records an exception rather than reporting success"], ["tests/payroll-finance-execution.test.mjs", "NEGATIVE: a batch already marked for external transmission is not eligible for sandbox reconciliation"], ["tests/people-finance-integration.test.mjs", "bank reconciliation records references only and cannot become a live transmission"]]],
  ["099", "monthly close and locked-period enforcement", [["tests/statutory-finance-close.test.mjs", "monthly close aggregates real revenue/GST/TDS, blocks without board approval, then locks"], ["tests/payroll-finance-execution.test.mjs", "NEGATIVE: a locked finance period refuses payroll posting and writes nothing"]]],
  ["100", "annual close, monthly completeness, P&L and authorization", [["tests/finance-year-closure.test.mjs", "complete 12-period Finance test year contains every required ledger family and balanced journals"], ["tests/finance-statutory-execution.test.mjs", "NEGATIVE: an annual return cannot be approved while monthly evidence is incomplete"], ["tests/finance-statutory-execution.test.mjs", "with all twelve months reviewed, a different checker approves the annual return"], ["tests/pnl-reporting-authorization.test.mjs", "an unauthenticated caller cannot read the P&L statement"]]],
];

for (const [suffix, objective, checks] of cases) {
  const caseId = `E2E100-T4-${suffix}`;
  test(`${caseId} — ${objective}`, () => {
    const ledger = new DatabaseSync(":memory:");
    ledger.exec("CREATE TABLE e2e100_t4_cases (case_id TEXT PRIMARY KEY,objective TEXT NOT NULL,status TEXT NOT NULL,checks INTEGER NOT NULL,completed_at INTEGER)");
    ledger.prepare("INSERT INTO e2e100_t4_cases (case_id,objective,status,checks) VALUES (?,?,?,?)").run(caseId, objective, "running", checks.length);
    const failures = [];
    for (const [file, name] of checks) { const result = runCheck(file, name); if (result.status !== 0) failures.push(result); }
    if (failures.length) {
      ledger.prepare("UPDATE e2e100_t4_cases SET status='failed',completed_at=? WHERE case_id=?").run(Date.now(), caseId);
      assert.fail(failures.map(item => `${item.file} :: ${item.name}\n${item.stdout}\n${item.stderr}\n${item.error || ""}`).join("\n---\n"));
    }
    ledger.prepare("UPDATE e2e100_t4_cases SET status='passed',completed_at=? WHERE case_id=?").run(Date.now(), caseId);
    const row = ledger.prepare("SELECT * FROM e2e100_t4_cases WHERE case_id=?").get(caseId);
    assert.equal(row.status, "passed"); assert.equal(row.checks, checks.length); ledger.close();
  });
}

test("E2E100-T4 case range is exact, unique and complete", () => {
  assert.equal(cases.length, 25);
  assert.deepEqual(cases.map(item => Number(item[0])), Array.from({ length: 25 }, (_, index) => 76 + index));
  assert.equal(new Set(cases.map(item => item[0])).size, 25);
});
