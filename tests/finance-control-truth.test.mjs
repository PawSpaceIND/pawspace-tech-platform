import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// The staff Finance control surface is what a finance reviewer signs a UAT round off against. It used to
// render 48 hardcoded rupee literals — "Net collections ₹42.14L", "Output GST ₹7.27L", "TDS payable
// ₹72,840", "284 auto-matched ₹43.82L" against a bank feed the registry records as
// production_setup_required, and a Ledger tab asserting "Dr ₹1,13,480 = Cr ₹1,13,480".
//
// The balanced-ledger literal is the sharpest of them: double-entry balance is the one invariant finance
// UAT exists to check, and hardcoding the equality meant it could never fail on screen no matter what the
// journal rows actually said.
//
// Alongside it, sourceStatus was a literal claiming "import-ready" / "integration-ready" / "Tally / Zoho
// Books ready". The integration registry records INT-BANK-01, INT-ACCT-01 and INT-TAX-01 as
// production_setup_required, and there is no OCR entry at all — so that label was backed by nothing.
//
// These tests execute the real GET handler and the real summary function.
// ---------------------------------------------------------------------------

const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `const workersUrl=${JSON.stringify(workersUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); },
  };
}

const summaryModule = () => import("../lib/finance-control-summary.ts");

// --- the computed figures --------------------------------------------------------------------------

test("every rendered finance figure is counted from the rows, not asserted", async () => {
  const { financeControlSummary } = await summaryModule();
  const summary = financeControlSummary({
    expenses: [{ amount: 2840, status: "approval_due" }, { amount: 11800, status: "held" }, { amount: 500, status: "paid" }],
    bills: [{ total_amount: 56640, status: "approval_due" }, { total_amount: 10000, status: "paid" }],
    journals: [{ debit: 48000, credit: 0 }, { debit: 0, credit: 48000 }],
    bank: [
      { amount: 1000, status: "matched" }, { amount: 250, status: "suggested" },
      { amount: 90, status: "unmatched" }, { amount: 33, status: "duplicate" },
    ],
  });

  assert.equal(summary.expenses, 2840 + 11800 + 500, "expenses total every claim, whatever its state");
  assert.equal(summary.payables, 56640, "payables exclude the paid bill");
  assert.equal(summary.pendingApprovals, 3, "two expenses and one bill await a decision");
  assert.deepEqual(summary.ledger, { debit: 48000, credit: 48000, balanced: true, entries: 2 });
  assert.equal(summary.bank.imported, 4);
  assert.deepEqual(summary.bank.autoMatched, { count: 1, amount: 1000 });
  assert.deepEqual(summary.bank.suggested, { count: 1, amount: 250 });
  assert.deepEqual(summary.bank.unmatched, { count: 1, amount: 90 });
  assert.deepEqual(summary.bank.duplicate, { count: 1, amount: 33 });
});

test("NEGATIVE: an unbalanced ledger is reported as unbalanced", async () => {
  // The whole point. The panel used to state Dr = Cr as a literal, so a book that did not balance still
  // rendered as balanced. Here one credit is short by a rupee and the surface has to say so.
  const { financeControlSummary } = await summaryModule();
  const summary = financeControlSummary({ journals: [{ debit: 48000, credit: 0 }, { debit: 0, credit: 47999 }] });
  assert.equal(summary.ledger.balanced, false, "a one-rupee break must surface, not be papered over");
  assert.equal(summary.ledger.debit, 48000);
  assert.equal(summary.ledger.credit, 47999);
});

test("floating-point addition does not report a balanced book as broken", async () => {
  const { financeControlSummary } = await summaryModule();
  const summary = financeControlSummary({
    journals: [{ debit: 0.1, credit: 0 }, { debit: 0.2, credit: 0 }, { debit: 0, credit: 0.3 }],
  });
  assert.equal(summary.ledger.balanced, true, "0.1 + 0.2 !== 0.3 in binary floating point; paise rounding handles it");
});

test("an empty finance database reports zeroes, never sample figures", async () => {
  const { financeControlSummary } = await summaryModule();
  const summary = financeControlSummary({});
  assert.equal(summary.expenses, 0);
  assert.equal(summary.payables, 0);
  assert.equal(summary.pendingApprovals, 0);
  assert.equal(summary.bank.imported, 0);
  assert.deepEqual(summary.ledger, { debit: 0, credit: 0, balanced: true, entries: 0 });
});

// --- what cannot be sourced is null, not invented ---------------------------------------------------

test("figures this endpoint cannot source come back null, each naming the surface that owns it", async () => {
  const { financeControlSummary, UNSOURCED_FINANCE_METRICS } = await summaryModule();
  const summary = financeControlSummary({});
  for (const key of ["netCollections", "outputGst", "tdsPayable", "providerPayable", "payrollPosting", "cashRunway"]) {
    assert.ok(key in summary.unsourced, `${key} must be declared`);
    assert.equal(summary.unsourced[key], null, `${key} must be null rather than a plausible number`);
    assert.ok(String(UNSOURCED_FINANCE_METRICS[key] || "").length > 10, `${key} must say where the real figure lives`);
  }
  assert.match(UNSOURCED_FINANCE_METRICS.outputGst, /gst-accounting/, "GST points at the surface that owns it");
  assert.match(UNSOURCED_FINANCE_METRICS.providerPayable, /INT-PAY-02/, "payouts name the unconnected integration");
});

// --- integration labels come from the registry, not from prose --------------------------------------

test("no finance integration is labelled live unless the registry says controlled_live_verified", async () => {
  const { financeSourceStatus, integrationLabel } = await summaryModule();
  const status = financeSourceStatus([
    { integrationCode: "INT-BANK-01", readinessState: "production_setup_required", credentialStatus: "missing" },
    { integrationCode: "INT-ACCT-01", readinessState: "production_setup_required", credentialStatus: "missing" },
    { integrationCode: "INT-TAX-01", readinessState: "production_setup_required", credentialStatus: "missing" },
    { integrationCode: "INT-PAY-01", readinessState: "code_ready", credentialStatus: "configured" },
  ]);

  for (const [key, value] of Object.entries(status)) {
    assert.doesNotMatch(String(value), /^Live/, `${key} must not read as live`);
  }
  assert.match(status.bankFeed, /not connected/, "an unconnected bank feed says so");
  assert.match(status.accountingExport, /not connected/, "Tally/Zoho export is not 'ready'");
  assert.match(status.gstFiling, /not connected/);
  assert.match(status.paymentGateway, /credentials present, not verified live/,
    "credentials present is NOT the same claim as a verified live integration");
  assert.equal(integrationLabel("controlled_live_verified"), "Live · verified",
    "the one state that does mean live still reads as live, so this is not vacuous");
});

test("an integration nobody registered reports as unregistered, not as ready", async () => {
  // Issue #232 tracks live OCR/vendor-bill ingestion. There is no INT-OCR-01 entry, and the old literal
  // called it "integration-ready" anyway.
  const { financeSourceStatus } = await summaryModule();
  const status = financeSourceStatus([]);
  assert.match(status.ocr, /Not registered/, "an absent registry entry cannot be dressed up as readiness");
  for (const value of Object.values(status)) assert.doesNotMatch(String(value), /ready/i);
});

// --- the real route, end to end ---------------------------------------------------------------------

/** Real security tables with a role that actually carries the permission under test. */
async function world(permissions = ["finance.view", "finance.manage"]) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  const auth = await import("../lib/server-auth.ts");
  await auth.ensureSecurityTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT OR REPLACE INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (?,?,?,?,0,?)")
    .run("finance_lead", "Finance lead", "Finance UAT reviewer", JSON.stringify(permissions), now);
  sqlite.prepare("INSERT OR REPLACE INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (?,?,?,?,0,?)")
    .run("groomer", "Groomer", "Service delivery only", JSON.stringify(["bookings.view"]), now);
  sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
    .run("u_fin", "finance@pawspace.in", "Finance Reviewer", "finance_lead", now, now);
  sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
    .run("u_groom", "groomer@pawspace.in", "Groomer", "groomer", now, now);
  return { sqlite, db };
}

const asUser = (email) => new Request("https://control.pawspace.test/api/finance-control", {
  headers: email
    ? { "oai-authenticated-user-email": email, "oai-authenticated-user-full-name": "Finance Reviewer" }
    : {},
});

test("the real GET handler serves computed figures and registry-derived labels", async () => {
  const { sqlite } = await world();
  const { GET } = await import("../app/api/finance-control/route.ts");
  const response = await GET(asUser("finance@pawspace.in"));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));

  assert.ok(body.data.summary, "the endpoint now serves a computed summary");
  const seededExpenses = sqlite.prepare("SELECT COALESCE(SUM(amount),0) total FROM finance_expenses").get().total;
  assert.equal(body.data.summary.expenses, seededExpenses,
    "the served total equals what the database holds — not a figure chosen for the screenshot");
  assert.equal(body.data.summary.bank.imported, sqlite.prepare("SELECT COUNT(*) n FROM finance_bank_transactions").get().n);

  for (const [key, value] of Object.entries(body.data.sourceStatus)) {
    assert.doesNotMatch(String(value), /import-ready|integration-ready|Books ready/,
      `${key} must no longer carry a hardcoded readiness claim`);
  }
});

// --- the panel itself -------------------------------------------------------------------------------

// --- finance authorization (requirement F) ----------------------------------------------------------

test("NEGATIVE: an anonymous caller cannot read the finance control surface", async () => {
  await world();
  const { GET } = await import("../app/api/finance-control/route.ts");
  const response = await GET(asUser(null));
  assert.notEqual(response.status, 200, "no identity must not reach finance data");
  const body = await response.json();
  assert.equal(body.data, undefined, "and no finance rows leak through the refusal body");
});

test("NEGATIVE: a non-finance role cannot read the finance control surface", async () => {
  await world();
  const { GET } = await import("../app/api/finance-control/route.ts");
  const response = await GET(asUser("groomer@pawspace.in"));
  assert.equal(response.status, 403, "a groomer holds bookings.view, never finance.view");
  const body = await response.json();
  assert.equal(body.data, undefined);
  assert.doesNotMatch(JSON.stringify(body), /finance_expenses|SELECT|sqlite/i,
    "the refusal must not leak schema or query internals");
});

test("an unknown email is refused rather than defaulted to a role", async () => {
  await world();
  const { GET } = await import("../app/api/finance-control/route.ts");
  const response = await GET(asUser("stranger@pawspace.in"));
  assert.notEqual(response.status, 200, "an email absent from app_users grants nothing");
});

test("finance data is never cached by an intermediary", async () => {
  await world();
  const { GET } = await import("../app/api/finance-control/route.ts");
  const response = await GET(asUser("finance@pawspace.in"));
  assert.equal(response.status, 200);
  assert.match(String(response.headers.get("cache-control")), /no-store/,
    "finance positions must not be cached between actors");
});

test("the staff panel no longer carries hardcoded rupee figures", async () => {
  // A source assertion on purpose: the defect WAS the literals in this file, so their absence is the
  // thing to guard. Two whitelisted strings remain because they are form placeholders, not reported
  // finance positions.
  const source = fs.readFileSync(new URL("../app/control/finance-control-panel.tsx", import.meta.url), "utf8");
  // Matches a rupee figure ANYWHERE in a string literal, not only a whole-string one. An earlier
  // version of this assertion anchored to the whole literal and so missed two figures embedded in
  // longer strings ("7 transactions · ₹84,290").
  const literals = source.match(/₹[0-9][0-9.,]*\s*(?:L|Cr)?/g) ?? [];
  assert.deepEqual(literals, [],
    `the panel must render counted figures, not literals — found: ${literals.join(", ")}`);
  assert.match(source, /summary/, "it renders the computed summary");
  assert.match(source, /Not connected/, "and says so plainly where nothing is wired");
});
