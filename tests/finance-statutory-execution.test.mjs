import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// GST maker/checker, executed rather than described.
//
// The existing coverage for these rules is a source assertion — assert.match(lib, /if\(text\(row\.
// prepared_by\)===actor\)throw new Error\("maker_checker_required"\)/). That proves the line is written.
// It cannot show that the refusal actually fires, that the package is left untouched when it does, or
// that a rejected approval writes no "reviewed" audit event. A statutory package that flipped to
// reviewed and THEN threw would satisfy the regex perfectly.
//
// lib/gst-accounting.ts is importable from the runner as of the parameter-property fix, so these drive
// the real /api/gst-accounting handler with real security tables and read the rows back.
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

const ORIGIN = "https://control.pawspace.test";
const MAKER = "maker@pawspace.in";
const CHECKER = "checker@pawspace.in";
const VIEWER = "viewer@pawspace.in";
const ENTITY = "ent_pawspace_india";
const REGISTRATION = "reg_ka_29";

/** Real security tables: a finance maker, a distinct finance checker, and a view-only finance actor. */
async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  const auth = await import("../lib/server-auth.ts");
  await auth.ensureSecurityTables(db);
  const now = Date.now();
  const role = (code, permissions) => sqlite
    .prepare("INSERT OR REPLACE INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (?,?,?,?,0,?)")
    .run(code, code, code, JSON.stringify(permissions), now);
  const user = (id, email, code) => sqlite
    .prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
    .run(id, email, email, code, now, now);
  role("finance_manage", ["finance.view", "finance.manage"]);
  role("finance_view", ["finance.view"]);
  user("u_maker", MAKER, "finance_manage");
  user("u_checker", CHECKER, "finance_manage");
  user("u_viewer", VIEWER, "finance_view");

  const gst = await import("../lib/gst-accounting.ts");
  await gst.ensureGstAccountingTables(db);
  const closeout = await import("../lib/finance-filing-closeout.ts");
  await closeout.ensureFinanceEntityScope(db);
  return { sqlite, db };
}

const post = async (actor, body) => {
  const { POST } = await import("../app/api/gst-accounting/route.ts");
  return POST(new Request(`${ORIGIN}/api/gst-accounting`, {
    method: "POST",
    headers: {
      "content-type": "application/json", origin: ORIGIN,
      ...(actor ? { "oai-authenticated-user-email": actor, "oai-authenticated-user-full-name": actor } : {}),
    },
    body: JSON.stringify(body),
  }));
};

/** Output tax for a month, so a generated package has something real to consolidate. */
function seedOutputTax(sqlite, periodCode, amount) {
  sqlite.prepare("INSERT INTO finance_tax_ledger (id,entity_id,registration_id,period_code,component,ledger_type,source_type,source_id,amount,source_event_key,created_at) VALUES (?,?,?,?,'igst','output','invoice',?,?,?,?)")
    .run(`txl_${periodCode}`, ENTITY, REGISTRATION, periodCode, `inv_${periodCode}`, amount, `evt_${periodCode}`, Date.now());
}

const packageRow = (sqlite, id) => sqlite.prepare("SELECT * FROM finance_statutory_packages WHERE id=?").get(id);
const reviewedEvents = (sqlite, entityId) => sqlite
  .prepare("SELECT COUNT(*) n FROM gst_accounting_audit_events WHERE entity_id=? AND action='reviewed'").get(entityId).n;

// --- monthly statutory package ----------------------------------------------------------------------

test("a finance maker generates a statutory package that persists as draft against their own name", async () => {
  const { sqlite } = await world();
  seedOutputTax(sqlite, "2026-07", 72700);
  const response = await post(MAKER, { action: "generate_statutory_package", entityId: ENTITY, registrationId: REGISTRATION, periodCode: "2026-07" });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));

  const row = packageRow(sqlite, body.data.id);
  assert.ok(row, "the package is persisted, not just returned");
  assert.equal(row.status, "draft", "a generated package is a draft awaiting a second human");
  assert.equal(row.prepared_by, MAKER, "and it records who prepared it");
  assert.ok(!String(row.reviewed_by || ""), "nobody has reviewed it yet");
});

test("NEGATIVE: the maker cannot approve their own package, and the refusal changes nothing", async () => {
  const { sqlite, db } = await world();
  seedOutputTax(sqlite, "2026-07", 72700);
  const generated = await (await post(MAKER, { action: "generate_statutory_package", entityId: ENTITY, registrationId: REGISTRATION, periodCode: "2026-07" })).json();
  const id = generated.data.id;
  const before = packageRow(sqlite, id);

  const response = await post(MAKER, { action: "approve_statutory_package", id, approvalReference: "CA-SIGNOFF-1", reason: "self approval attempt" });
  const body = await response.json();
  assert.notEqual(response.status, 200, "self-approval must be refused");
  // The route redacts internal reasons through the governed boundary, so the caller sees a generic
  // failure. That is correct — and asserted here so a future change cannot start leaking internals.
  assert.doesNotMatch(JSON.stringify(body), /maker_checker_required|prepared_by|SELECT/,
    "the refusal must not leak the internal rule or schema to the caller");
  // The exact reason code is proven against the module, where it is not redacted.
  const gst = await import("../lib/gst-accounting.ts");
  await assert.rejects(
    () => gst.approveStatutoryPackage(db, { id, approvalReference: "CA-SIGNOFF-1" }, MAKER),
    /maker_checker_required/, "the module refuses self-approval by name");

  const after = packageRow(sqlite, id);
  assert.equal(after.status, "draft", "the package is still a draft");
  assert.ok(!String(after.reviewed_by || ""), "reviewed_by is still empty");
  assert.deepEqual(after, before, "the refused approval left the row byte-for-byte unchanged");
  assert.equal(reviewedEvents(sqlite, id), 0, "and wrote no 'reviewed' audit event");
});

test("NEGATIVE: a checker without an approval reference is refused, and the package stays draft", async () => {
  const { sqlite, db } = await world();
  seedOutputTax(sqlite, "2026-07", 72700);
  const generated = await (await post(MAKER, { action: "generate_statutory_package", entityId: ENTITY, registrationId: REGISTRATION, periodCode: "2026-07" })).json();
  const id = generated.data.id;

  const response = await post(CHECKER, { action: "approve_statutory_package", id, reason: "no reference supplied" });
  assert.notEqual(response.status, 200);
  const gst = await import("../lib/gst-accounting.ts");
  await assert.rejects(() => gst.approveStatutoryPackage(db, { id }, CHECKER), /approval_reference_required/);
  assert.equal(packageRow(sqlite, id).status, "draft");
  assert.equal(reviewedEvents(sqlite, id), 0);
});

test("a different finance actor approves with a reference, and the review is auditable", async () => {
  const { sqlite } = await world();
  seedOutputTax(sqlite, "2026-07", 72700);
  const generated = await (await post(MAKER, { action: "generate_statutory_package", entityId: ENTITY, registrationId: REGISTRATION, periodCode: "2026-07" })).json();
  const id = generated.data.id;

  const response = await post(CHECKER, { action: "approve_statutory_package", id, approvalReference: "CA-SIGNOFF-1", reason: "reviewed by CA" });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));

  const row = packageRow(sqlite, id);
  assert.equal(row.status, "reviewed");
  assert.equal(row.reviewed_by, CHECKER, "the checker is recorded, not the maker");
  assert.equal(row.approval_reference, "CA-SIGNOFF-1");
  assert.equal(reviewedEvents(sqlite, id), 1, "exactly one review event is persisted");
  const event = sqlite.prepare("SELECT actor_id,action FROM gst_accounting_audit_events WHERE entity_id=? AND action='reviewed'").get(id);
  assert.equal(event.actor_id, CHECKER, "the audit trail names the real approver");
});

// --- annual return: same maker/checker rule, plus the monthly-completeness reconciliation -------------

/** Generate and (optionally) approve all twelve monthly packages of FY 2026-27. */
async function twelveMonths(sqlite, { approve }) {
  const months = [];
  for (let index = 0; index < 12; index += 1) {
    const year = index < 9 ? 2026 : 2027;
    const month = ((3 + index) % 12) + 1; // April 2026 → March 2027
    const periodCode = `${year}-${String(month).padStart(2, "0")}`;
    seedOutputTax(sqlite, periodCode, 1000 + index);
    const generated = await (await post(MAKER, { action: "generate_statutory_package", entityId: ENTITY, registrationId: REGISTRATION, periodCode })).json();
    if (approve) await post(CHECKER, { action: "approve_statutory_package", id: generated.data.id, approvalReference: `CA-${periodCode}`, reason: "monthly review" });
    months.push(periodCode);
  }
  return months;
}

test("NEGATIVE: an annual return cannot be approved while monthly evidence is incomplete", async () => {
  const { sqlite, db } = await world();
  await twelveMonths(sqlite, { approve: false });
  const generated = await (await post(MAKER, { action: "generate_annual_return", entityId: ENTITY, registrationId: REGISTRATION, financialYear: "2026-27" })).json();
  const id = generated.data.id;

  const response = await post(CHECKER, { action: "approve_annual_return", id, approvalReference: "CA-ANNUAL-1", reason: "annual sign-off" });
  assert.notEqual(response.status, 200, "twelve unreviewed months must block the annual approval");
  const closeout = await import("../lib/finance-filing-closeout.ts");
  await assert.rejects(
    () => closeout.approveAnnualReturnSafe(db, { id, approvalReference: "CA-ANNUAL-1" }, CHECKER),
    /annual_reconciliation_not_clean/, "the reconciliation gate refuses by name");
  assert.equal(sqlite.prepare("SELECT status FROM finance_annual_returns WHERE id=?").get(id).status, "draft");
});

test("NEGATIVE: the annual maker cannot approve their own return either", async () => {
  const { sqlite, db } = await world();
  await twelveMonths(sqlite, { approve: true });
  const generated = await (await post(MAKER, { action: "generate_annual_return", entityId: ENTITY, registrationId: REGISTRATION, financialYear: "2026-27" })).json();
  const id = generated.data.id;

  const response = await post(MAKER, { action: "approve_annual_return", id, approvalReference: "CA-ANNUAL-1", reason: "self approval attempt" });
  assert.notEqual(response.status, 200);
  const closeout = await import("../lib/finance-filing-closeout.ts");
  await assert.rejects(
    () => closeout.approveAnnualReturnSafe(db, { id, approvalReference: "CA-ANNUAL-1" }, MAKER),
    /maker_checker_required/, "the annual path enforces the same two-human rule");
  const row = sqlite.prepare("SELECT status,reviewed_by FROM finance_annual_returns WHERE id=?").get(id);
  assert.equal(row.status, "draft");
  assert.ok(!String(row.reviewed_by || ""));
});

test("with all twelve months reviewed, a different checker approves the annual return", async () => {
  const { sqlite } = await world();
  await twelveMonths(sqlite, { approve: true });
  const generated = await (await post(MAKER, { action: "generate_annual_return", entityId: ENTITY, registrationId: REGISTRATION, financialYear: "2026-27" })).json();
  const id = generated.data.id;

  const response = await post(CHECKER, { action: "approve_annual_return", id, approvalReference: "CA-ANNUAL-1", reason: "annual sign-off" });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const row = sqlite.prepare("SELECT status,reviewed_by,approval_reference FROM finance_annual_returns WHERE id=?").get(id);
  assert.equal(row.status, "reviewed");
  assert.equal(row.reviewed_by, CHECKER);
  assert.equal(row.approval_reference, "CA-ANNUAL-1");
});

test("the annual return does not claim live GST filing", async () => {
  const { sqlite } = await world();
  await twelveMonths(sqlite, { approve: true });
  const generated = await (await post(MAKER, { action: "generate_annual_return", entityId: ENTITY, registrationId: REGISTRATION, financialYear: "2026-27" })).json();
  assert.equal(generated.data.liveFilingEnabled, false, "an internal statutory package is not a portal filing");
  assert.ok(sqlite, "database retained");
});

// --- authorization on these mutations ----------------------------------------------------------------

test("NEGATIVE: an anonymous caller cannot generate or approve statutory packages", async () => {
  const { sqlite } = await world();
  seedOutputTax(sqlite, "2026-07", 72700);
  const response = await post(null, { action: "generate_statutory_package", entityId: ENTITY, registrationId: REGISTRATION, periodCode: "2026-07" });
  assert.notEqual(response.status, 200);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM finance_statutory_packages").get().n, 0, "and nothing is written");
});

test("NEGATIVE: a finance-view-only actor cannot perform a finance-manage mutation", async () => {
  const { sqlite } = await world();
  seedOutputTax(sqlite, "2026-07", 72700);
  const response = await post(VIEWER, { action: "generate_statutory_package", entityId: ENTITY, registrationId: REGISTRATION, periodCode: "2026-07" });
  assert.equal(response.status, 403, "finance.view is not finance.manage");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM finance_statutory_packages").get().n, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM gst_accounting_audit_events").get().n, 0,
    "a refused mutation writes no audit event at all, misleading or otherwise");
});

// --- accounting export: the Tally/Zoho boundary ------------------------------------------------------

const OTHER_ENTITY = "ent_pawspace_singapore";

/** Two legal entities, two periods, posted and unposted journals, and one approved mapping. */
function seedExportWorld(sqlite) {
  const now = Date.now();
  sqlite.prepare("INSERT INTO accounting_mapping_versions (id,entity_id,version,status,effective_from,mapping_json,approval_reference,approved_by,approved_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("map_v1", ENTITY, 1, "active", "2026-01-01", JSON.stringify({ "6100": "Salaries" }), "MAP-APPROVAL-1", CHECKER, now, now, now);
  // A mapping for the other entity too, so entity scoping is doing the work rather than scarcity.
  sqlite.prepare("INSERT INTO accounting_mapping_versions (id,entity_id,version,status,effective_from,mapping_json,approval_reference,approved_by,approved_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run("map_sg_v1", OTHER_ENTITY, 1, "active", "2026-01-01", JSON.stringify({}), "MAP-APPROVAL-SG", CHECKER, now, now, now);

  const line = (id, entityId, periodCode, posted, debit) => sqlite
    .prepare("INSERT INTO finance_journal_entries (id,entity_id,entry_date,source_type,source_id,account_code,cost_centre,vertical,debit,credit,narration,period_code,posted,created_at) VALUES (?,?,?,?,?,?,NULL,NULL,?,?,?,?,?,?)")
    .run(id, entityId, `${periodCode}-15`, "journal", `src_${id}`, "6100", debit, debit ? 0 : 500, id, periodCode, posted, now);

  line("J-WANTED-1", ENTITY, "2026-07", 1, 500);      // in scope
  line("J-WANTED-2", ENTITY, "2026-07", 1, 0);        // in scope (credit side)
  line("J-UNPOSTED", ENTITY, "2026-07", 0, 700);      // draft — must not be exported
  line("J-OTHERPERIOD", ENTITY, "2026-08", 1, 900);   // wrong period
  line("J-OTHERENTITY", OTHER_ENTITY, "2026-07", 1, 1100); // wrong legal entity
}

test("an accounting export contains only the requested entity, period, posted lines and approved mapping", async () => {
  const { sqlite } = await world();
  seedExportWorld(sqlite);
  const response = await post(MAKER, { action: "generate_accounting_export", entityId: ENTITY, periodCode: "2026-07", target: "tally", reason: "month close export" });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));

  const run = sqlite.prepare("SELECT * FROM accounting_export_runs WHERE id=?").get(body.data.id);
  assert.ok(run, "the export run is persisted");
  assert.equal(run.entity_id, ENTITY);
  assert.equal(run.period_code, "2026-07");
  assert.equal(run.mapping_id, "map_v1", "the approved mapping for this entity is the one used");

  const exported = JSON.parse(String(run.source_snapshot_json)).journals.map((entry) => entry.id).sort();
  assert.deepEqual(exported, ["J-WANTED-1", "J-WANTED-2"],
    "an unposted line, another period and another legal entity are all excluded");
  assert.equal(body.data.journalCount, 2);
});

test("NEGATIVE: an export without an approved mapping fails closed as configuration-required", async () => {
  const { sqlite, db } = await world();
  // Journals exist, but no mapping is approved for this entity.
  sqlite.prepare("INSERT INTO finance_journal_entries (id,entity_id,entry_date,source_type,source_id,account_code,cost_centre,vertical,debit,credit,narration,period_code,posted,created_at) VALUES ('J1',?,'2026-07-15','journal','s1','6100',NULL,NULL,500,0,'n','2026-07',1,?)")
    .run(ENTITY, Date.now());
  const response = await post(MAKER, { action: "generate_accounting_export", entityId: ENTITY, periodCode: "2026-07", target: "tally" });
  assert.notEqual(response.status, 200, "no mapping means no export");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM accounting_export_runs").get().n, 0, "and nothing is persisted");

  const closeout = await import("../lib/finance-filing-closeout.ts");
  await assert.rejects(
    () => closeout.generateAccountingExportSafe(db, { entityId: ENTITY, periodCode: "2026-07", target: "tally" }, MAKER),
    /active_accounting_mapping/, "the module names the missing configuration");
});

test("regenerating an identical export is deterministic and creates no second run", async () => {
  const { sqlite } = await world();
  seedExportWorld(sqlite);
  const first = await (await post(MAKER, { action: "generate_accounting_export", entityId: ENTITY, periodCode: "2026-07", target: "tally" })).json();
  const second = await (await post(MAKER, { action: "generate_accounting_export", entityId: ENTITY, periodCode: "2026-07", target: "tally" })).json();

  assert.equal(second.data.id, first.data.id, "the same export run is returned");
  assert.equal(second.data.checksum, first.data.checksum, "and the snapshot checksum is deterministic");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM accounting_export_runs").get().n, 1);
});

test("the export is not represented as a live Tally/Zoho post, and acknowledgement needs a reference", async () => {
  const { sqlite } = await world();
  seedExportWorld(sqlite);
  const generated = await (await post(MAKER, { action: "generate_accounting_export", entityId: ENTITY, periodCode: "2026-07", target: "tally" })).json();
  assert.equal(generated.data.productionPost, false, "generating an export posts nothing to an accounting platform");
  assert.equal(sqlite.prepare("SELECT status FROM accounting_export_runs WHERE id=?").get(generated.data.id).status, "generated",
    "it is 'generated', never 'posted'");

  const refused = await post(CHECKER, { action: "acknowledge_accounting_export", id: generated.data.id });
  assert.notEqual(refused.status, 200, "acknowledgement without a reference is refused");
  assert.equal(sqlite.prepare("SELECT status FROM accounting_export_runs WHERE id=?").get(generated.data.id).status, "generated");

  const accepted = await post(CHECKER, { action: "acknowledge_accounting_export", id: generated.data.id, ackReference: "TALLY-ACK-9911" });
  assert.equal(accepted.status, 200, JSON.stringify(await accepted.clone().json()));
  const run = sqlite.prepare("SELECT status,ack_reference FROM accounting_export_runs WHERE id=?").get(generated.data.id);
  assert.equal(run.status, "acknowledged", "acknowledgement is explicit evidence a human recorded, not an inference");
  assert.equal(run.ack_reference, "TALLY-ACK-9911");
});

test("export generation and acknowledgement are attributable in the audit trail", async () => {
  const { sqlite } = await world();
  seedExportWorld(sqlite);
  const generated = await (await post(MAKER, { action: "generate_accounting_export", entityId: ENTITY, periodCode: "2026-07", target: "tally" })).json();
  await post(CHECKER, { action: "acknowledge_accounting_export", id: generated.data.id, ackReference: "TALLY-ACK-9911" });

  const events = sqlite.prepare("SELECT action,actor_id FROM gst_accounting_audit_events WHERE entity_id=? ORDER BY created_at").all(generated.data.id);
  const byAction = new Map(events.map((event) => [event.action, event.actor_id]));
  assert.equal(byAction.get("generated"), MAKER, "the audit trail names who generated it");
  assert.equal(byAction.get("acknowledged"), CHECKER, "and who acknowledged it");
});

test("invoice replay preserves immutable tax-ledger row identity and repeated service lines", async () => {
  const { sqlite } = await world();
  const now = Date.now();
  sqlite.prepare("INSERT INTO finance_entities (id,legal_name,country_code,status,approved_by,approved_at,created_at,updated_at) VALUES (?,?,?,'active',?,?,?,?)")
    .run(ENTITY, "PawSpace Test Entity", "IN", CHECKER, now, now, now);
  sqlite.prepare("INSERT INTO tax_registrations (id,entity_id,jurisdiction,registration_type,registration_reference,status,effective_from,approved_by,approved_at,created_at,updated_at) VALUES (?,?,?,?,?,'active',?,?,?,?,?)")
    .run(REGISTRATION, ENTITY, "test", "test_registration", "TEST-REG", "2026-04-01", CHECKER, now, now, now);
  sqlite.prepare("INSERT INTO tax_policy_versions (id,entity_id,version,status,effective_from,policy_json,approval_reference,approved_by,approved_at,created_at,updated_at) VALUES ('policy_test',?,1,'active','2026-04-01','{}','TEST-POLICY',?,?,?,?)")
    .run(ENTITY, CHECKER, now, now, now);
  sqlite.prepare("INSERT INTO tax_classifications (id,policy_id,service_code,classification_code,tax_component_json,place_of_supply_rule,input_tax_rule,created_at) VALUES ('class_test','policy_test','grooming','TEST-CLASS','[{\"code\":\"test_tax\",\"rate\":10}]','configured_test_rule','configured_test_rule',?)")
    .run(now);
  sqlite.prepare("INSERT INTO finance_document_series (id,entity_id,document_type,prefix,next_number,padding,policy_id,status,updated_at) VALUES ('series_invoice',?,'invoice','TEST-INV-',1,4,'policy_test','active',?)")
    .run(ENTITY, now);

  const request = { action: "issue_invoice", entityId: ENTITY, customerId: "customer_test", sourceType: "booking", sourceId: "booking_test", sourceEventKey: "invoice-event-test", issueDate: "2026-07-15", currency: "INR", reason: "T4 immutable invoice issue", lines: [
    { lineKey: "line-a", description: "Configured test line A", serviceCode: "grooming", taxableAmount: 1000 },
    { lineKey: "line-b", description: "Configured test line B", serviceCode: "grooming", taxableAmount: 500 },
  ] };
  const first = await post(MAKER, request);
  assert.equal(first.status, 200, JSON.stringify(await first.clone().json()));
  const before = sqlite.prepare("SELECT id,source_event_key,amount,created_at FROM finance_tax_ledger WHERE source_type='invoice' ORDER BY source_event_key").all();
  assert.equal(before.length, 2, "two repeated service lines retain separate configured tax truth");

  const replay = await post(MAKER, request);
  assert.equal(replay.status, 200, JSON.stringify(await replay.clone().json()));
  const after = sqlite.prepare("SELECT id,source_event_key,amount,created_at FROM finance_tax_ledger WHERE source_type='invoice' ORDER BY source_event_key").all();
  assert.deepEqual(after, before, "idempotent invoice replay must not delete and recreate posted tax history");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM finance_invoices WHERE source_event_key='invoice-event-test'").get().n, 1);
});
