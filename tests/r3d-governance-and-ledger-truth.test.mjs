/*
 * R3-D / F5 + F6 + F7 + F8 - four governance defects the runtime audit met on the finance desk.
 *
 * F8  "Monthly board approval recorded (founder policy)" is the last item before a month is locked, and
 *     a `finance` operator could satisfy it themselves: the row was written with approver_role='finance'
 *     and the same identity then closed and locked the month. Every other statutory sign-off here needs
 *     two people. Board approval now requires a board-level identity.
 *
 * F7  POST /api/funeral-memorial {action:"create"} against a service type that is not enabled answered
 *     409 {"error":"Unable to update funeral or memorial request"}. The engine threw
 *     `new Response("This service type is not enabled",{status:409})`; authError() keeps the status and
 *     REPLACES the body, so a governed refusal reached the operator anonymously.
 *
 * F6  A correctly balanced double entry was published as TWO `unbalanced_journal` anomalies at
 *     severity "high", because the grouper stripped a HYPHEN suffix from ids that
 *     app/api/finance-control/route.ts mints with an UNDERSCORE. atlas ledgerReconcile derives
 *     `balanced` from that list, so an agent asking "is the ledger balanced?" was told no.
 *
 * F5  Generate statutory package returned 200 with no entity and no registration selected and persisted
 *     a package for legal entity "". prepare_gstr8 likewise returned a `prepared` Rs 0 statement for a
 *     month whose compute_tcs was refusing configuration_required.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";

installWorkersHooks("__R3D_GOV_DB__");

const { ensureSecurityTables } = await import("../lib/server-auth.ts");
const statutoryRoute = await import("../app/api/statutory-compliance/route.ts");
const funeralRoute = await import("../app/api/funeral-memorial/route.ts");
const financeControlRoute = await import("../app/api/finance-control/route.ts");
const accounting = await import("../lib/gst-accounting.ts");
const governance = await import("../lib/finance-intelligence-governance.ts");
const atlas = await import("../lib/atlas-phase2-vertical-tools.ts");
const tcs = await import("../lib/statutory-tcs.ts");
const close = await import("../lib/finance-monthly-close.ts");
const statutory = await import("../lib/statutory-compliance.ts");

const HOST = "https://ops.pawspace.example";
const FINANCE = "r3d.finance@pawspace.test";
const FINANCE2 = "r3d.finance2@pawspace.test";
const FOUNDER = "r3d.founder@pawspace.test";
const PERIOD = "2026-08";

const as = (email, extra = {}) => ({ headers: { "oai-authenticated-user-email": email, "content-type": "application/json", origin: HOST, ...extra } });

async function world() {
  const harness = freshCountingD1();
  globalThis.__R3D_GOV_DB__ = harness.db;
  await ensureSecurityTables(harness.db);
  const insert = harness.sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)");
  insert.run("u-fin", FINANCE, "Finance operator", "finance", 1, 1);
  insert.run("u-fin2", FINANCE2, "Second finance operator", "finance", 1, 1);
  insert.run("u-founder", FOUNDER, "Founder", "founder", 1, 1);
  return harness;
}
const body = async (response) => ({ status: response.status, json: await response.json() });

// =============================================================================================
// F8 - board approval is not a Finance self-certification
// =============================================================================================

test("F8 a finance operator cannot record the board's own approval of the month's accounts", async () => {
  const w = await world();
  const refused = await body(await statutoryRoute.POST(new Request(`${HOST}/api/statutory-compliance`, {
    ...as(FINANCE), method: "POST", body: JSON.stringify({ action: "board_approve", period: PERIOD, minutesReference: "BOARD-R3D" }),
  })));

  assert.equal(refused.status, 403, "the finance role cannot resolve the board's approval");
  assert.match(String(refused.json.error), /board-level identity/, "and is told why, in words, not a token");
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM board_approvals").get().n, 0, "nothing was written");

  // The month therefore stays blocked on exactly this item - the check now gates on something.
  const view = await close.monthlyCloseView(w.db, { period: PERIOD, actorId: FINANCE });
  const item = view.checklist.find((c) => c.key === "board_approved");
  assert.equal(item.ok, false);
  assert.match(item.detail, /board-level identity/);
});

test("F8 the founder records it, and the close then carries BOTH identities on the record", async () => {
  const w = await world();
  const approved = await body(await statutoryRoute.POST(new Request(`${HOST}/api/statutory-compliance`, {
    ...as(FOUNDER), method: "POST", body: JSON.stringify({ action: "board_approve", period: PERIOD, minutesReference: "BOARD-R3D" }),
  })));
  assert.equal(approved.status, 201);

  const row = w.sqlite.prepare("SELECT approved_by,approver_role FROM board_approvals WHERE period=?").get(PERIOD);
  assert.equal(String(row.approved_by), FOUNDER);
  assert.equal(String(row.approver_role), "founder", "never 'finance', which is what the audit found on the row");

  const view = await close.monthlyCloseView(w.db, { period: PERIOD, actorId: FINANCE });
  assert.equal(view.boardApproval.approved, true);
  assert.equal(view.boardApproval.approverRole, "founder");
  assert.match(view.checklist.find((c) => c.key === "board_approved").detail, /\(founder\)/,
    "the operator can SEE which identity cleared the final check, not just that it is green");
});

test("F8 the board-level gate is derived from the role catalogue, not from who is signed in", async () => {
  const w = await world();
  for (const role of ["finance", "admin", "manager", "auditor", "associate"]) {
    assert.equal(statutory.isBoardApprover(role), false, `${role} is an operating role, not the board`);
  }
  for (const role of ["founder", "superuser"]) assert.equal(statutory.isBoardApprover(role), true);
  assert.equal(statutory.isBoardApprover("some_renamed_owner_role", ["*"]), true, "a renamed wildcard role still qualifies");
  assert.equal(statutory.isBoardApprover("finance", ["finance.manage", "finance.view"]), false, "finance.manage is not board authority");
  await statutory.ensureStatutoryTables(w.db);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM board_approvals").get().n, 0);
});

// =============================================================================================
// F7 - a governed refusal reaching the operator anonymously
// =============================================================================================

test("F7 a funeral service type that is not enabled refuses IN WORDS, not as the route fallback", async () => {
  await world();
  const refused = await body(await funeralRoute.POST(new Request(`${HOST}/api/funeral-memorial`, {
    ...as(FOUNDER), method: "POST",
    body: JSON.stringify({ action: "create", customerId: "CUS-R3D", petName: "R3D-Simba", petSpecies: "dog", pickupAddress: "12 Residency Road", serviceType: "cremation", memorialOption: "none" }),
  })));
  assert.equal(refused.status, 409, "the status was never the problem");
  assert.equal(refused.json.error, "This service type is not enabled",
    "the engine's own sentence must survive authError() instead of being replaced by the route fallback");
  assert.notEqual(refused.json.error, "Unable to update funeral or memorial request");
});

test("F7 the sweep: the engine's other business rules are governed too", async () => {
  const w = await world();
  const post = (payload) => funeralRoute.POST(new Request(`${HOST}/api/funeral-memorial`, { ...as(FOUNDER), method: "POST", body: JSON.stringify(payload) }));
  await post({ action: "save_service_config", serviceType: "cremation", enabled: true, baseAmount: 7500, cashAllowed: false });
  const created = await body(await post({ action: "create", customerId: "CUS-R3D", petName: "R3D-Simba", petSpecies: "dog", pickupAddress: "12 Residency Road", serviceType: "cremation", memorialOption: "none" }));
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const caseId = created.json.data.id;

  // Cash was explicitly NOT enabled for this service type; closure needs the ritual confirmed first;
  // a refund needs a paid case. Each is a rule the operator must be able to read.
  const cash = await body(await post({ action: "record_payment", caseId, paymentMode: "cash_uat" }));
  assert.equal(cash.status, 409);
  assert.equal(cash.json.error, "Cash is not enabled for this service type");

  const closure = await body(await post({ action: "close_case", caseId, closureNote: "closing early" }));
  assert.equal(closure.status, 409);
  assert.equal(closure.json.error, "Ritual completion must be confirmed before closure");

  const refund = await body(await post({ action: "request_refund", caseId, refundAmount: 100, reason: "changed mind" }));
  assert.equal(refund.status, 409);
  assert.equal(refund.json.error, "Only paid funeral cases can request a refund");

  const milestone = await body(await post({ action: "complete_milestone", caseId, milestoneCode: "not_a_milestone" }));
  assert.equal(milestone.status, 400);
  assert.equal(milestone.json.error, "Unknown funeral milestone");
  assert.equal(String(w.sqlite.prepare("SELECT status FROM funeral_cases WHERE id=?").get(caseId).status), "urgent_request", "and none of them moved the case");
});

// =============================================================================================
// F6 - a balanced journal is balanced, whatever punctuation its id uses
// =============================================================================================

/** Approve one expense through the REAL finance-control route, which is the underscore id writer. */
async function approveExpenseThroughTheRoute(w) {
  w.sqlite.exec("CREATE TABLE IF NOT EXISTS finance_expenses (id text PRIMARY KEY NOT NULL,entity_id text,expense_date text NOT NULL,merchant text NOT NULL,category_code text,cost_centre text NOT NULL,vertical text NOT NULL,amount real NOT NULL,status text NOT NULL DEFAULT 'submitted',created_by text,created_at integer NOT NULL,updated_at integer NOT NULL)");
  const version = 1_760_000_000_000;
  w.sqlite.prepare("INSERT INTO finance_expenses (id,entity_id,expense_date,merchant,category_code,cost_centre,vertical,amount,status,created_by,created_at,updated_at) VALUES ('EXP-R3D','pawspace_india',?,'Pet Supplies Co','supplies','ops','grooming',5000,'submitted',?,?,?)")
    .run(`${PERIOD}-11`, FINANCE2, version, version);
  const response = await financeControlRoute.PATCH(new Request(`${HOST}/api/finance-control`, {
    ...as(FINANCE, { "if-match": String(version) }), method: "PATCH", body: JSON.stringify({ entity: "expense", id: "EXP-R3D", action: "approve", reason: "Approved against the receipt" }),
  }));
  assert.equal(response.status, 200, `the expense must approve: ${await response.clone().text()}`);
  return response;
}

test("F6 a balanced double entry posted by the real route is NOT reported as an imbalance", async () => {
  const w = await world();
  await approveExpenseThroughTheRoute(w);

  const lines = w.sqlite.prepare("SELECT id,source_type,source_id,debit,credit FROM finance_journal_entries ORDER BY id").all();
  assert.equal(lines.length, 2, "an expense approval posts exactly one balanced double entry");
  assert.ok(lines.every((l) => String(l.id).includes("_")), "and the route mints its line ids with an UNDERSCORE - the shape the grouper could not see");
  assert.equal(Number(lines[0].debit) + Number(lines[1].debit), Number(lines[0].credit) + Number(lines[1].credit));

  const result = await governance.detectFinanceAnomalies(w.db, { periodCode: PERIOD });
  const unbalanced = result.anomalies.filter((a) => a.type === "unbalanced_journal");
  assert.deepEqual(unbalanced, [], "a balanced journal must produce no anomaly at all, let alone two at severity high");
});

test("F6 and the agent-facing answer to 'is the ledger balanced?' is now true", async () => {
  const w = await world();
  await approveExpenseThroughTheRoute(w);
  const reconcile = await atlas.executePhase2Tool(w.db, {
    agentCode: "finance", goalId: "GOAL-R3D", toolCode: "finance.ledger.reconcile",
    arguments: { periodCode: PERIOD },
    actor: { email: FINANCE, roleCode: "finance", permissions: ["finance.view", "finance.manage"] },
    env: { PAWSPACE_AI_EXECUTIVE_ACTIVE: "true", AI_ATLAS_ACTIVE: "true", AI_FINANCE_ACTIVE: "true" },
  });
  assert.equal(reconcile.status, "completed", `the read tool must run: ${JSON.stringify(reconcile)}`);
  assert.equal(reconcile.result.balanced, true, "this is what an agent reads; it said false for every correctly balanced journal");
  assert.deepEqual(reconcile.result.unbalancedJournals, []);
});

test("F6 a genuinely unbalanced journal is still caught, in either punctuation", async () => {
  const w = await world();
  await approveExpenseThroughTheRoute(w);
  const now = Date.now();
  const insert = w.sqlite.prepare("INSERT INTO finance_journal_entries (id,entity_id,entry_date,source_type,source_id,account_code,cost_centre,vertical,debit,credit,narration,period_code,posted,created_at) VALUES (?,?,?,?,?,?,'ops','grooming',?,?,?,?,1,?)");
  // Underscore-minted, genuinely out by 100.
  insert.run("jbad_1", "pawspace_india", `${PERIOD}-12`, "expense", "EXP-BAD", "6200", 900, 0, "bad entry", PERIOD, now);
  insert.run("jbad_2", "pawspace_india", `${PERIOD}-12`, "expense", "EXP-BAD", "2100", 0, 1000, "bad entry", PERIOD, now);
  // Hyphen-minted, also out by 50 - the shape lib/finance-accounts.ts and payroll write.
  insert.run("jold-1", "pawspace_india", `${PERIOD}-13`, "payroll_run", "PR-BAD", "6100", 500, 0, "bad payroll", PERIOD, now);
  insert.run("jold-2", "pawspace_india", `${PERIOD}-13`, "payroll_run", "PR-BAD", "2300", 0, 450, "bad payroll", PERIOD, now);

  const result = await governance.detectFinanceAnomalies(w.db, { periodCode: PERIOD });
  const unbalanced = result.anomalies.filter((a) => a.type === "unbalanced_journal");
  assert.equal(unbalanced.length, 2, "exactly the two broken journals, and not the balanced one beside them");
  assert.deepEqual(unbalanced.map((a) => a.subjectId).sort(), ["expense:EXP-BAD", "payroll_run:PR-BAD"]);
});

// =============================================================================================
// F5 - a statutory artefact needs a legal entity
// =============================================================================================

test("F5 a statutory package cannot be prepared for legal entity \"\"", async () => {
  const w = await world();
  for (const scope of [
    { entityId: "", registrationId: "", periodCode: PERIOD },
    { entityId: "ent_x", registrationId: "", periodCode: PERIOD },
    { entityId: "", registrationId: "reg_x", periodCode: PERIOD },
    { entityId: "ent_x", registrationId: "reg_x", periodCode: "" },
    { entityId: "ent_x", registrationId: "reg_x", periodCode: "2026-13" },
  ]) {
    await assert.rejects(() => accounting.generateStatutoryPackage(w.db, scope, FINANCE), /statutory_package_scope_required/,
      `an empty or malformed scope must be refused: ${JSON.stringify(scope)}`);
  }
  await accounting.ensureGstAccountingTables(w.db);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM finance_statutory_packages").get().n, 0,
    "nothing was persisted - the audit found a COUNTERSIGNED package on record for an empty entity");
});

test("F5 a GSTR-8 statement is refused for a month PawSpace has no registration for", async () => {
  const w = await world();
  await tcs.ensureStatutoryTcsTables(w.db);
  await accounting.ensureGstAccountingTables(w.db);

  // Exactly the audited state: compute_tcs refuses configuration_required:active_operator_gstin ...
  await assert.rejects(() => tcs.computeMonthlyTcsStatutory(w.db, { period: "2026-09", actorId: FINANCE }), (error) => error instanceof Response && error.status === 409);
  // ... so preparing a statement for the same month must refuse too, instead of recording "prepared - Rs 0".
  await assert.rejects(() => tcs.prepareGstr8Statutory(w.db, { period: "2026-09", actorId: FINANCE }), (error) => error instanceof Response && error.status === 409);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM tcs_statements").get().n, 0,
    "no statement is on record, so the dashboard cannot read a return that could not be computed as a completed one");

  // With a registration in place, a month with genuinely no marketplace supply still files a real nil.
  const t = Date.now();
  w.sqlite.prepare("INSERT INTO finance_entities (id,legal_name,country_code,status,created_at,updated_at) VALUES ('pawspace_india','PawSpace India Pvt Ltd','IN','active',?,?)").run(t, t);
  w.sqlite.prepare("INSERT INTO tax_registrations (id,entity_id,jurisdiction,registration_type,registration_reference,status,effective_from,effective_to,approved_by,approved_at,created_at,updated_at) VALUES ('reg_r3d','pawspace_india','KA','GSTIN','29AABCP1234A1Z5','active','2026-04-01',NULL,'board',?,?,?)").run(t, t, t);
  const nil = await tcs.prepareGstr8Statutory(w.db, { period: "2026-09", actorId: FINANCE });
  assert.equal(nil.totalTcs, 0);
  assert.equal(nil.supplierCount, 0);
  assert.equal(String(w.sqlite.prepare("SELECT status FROM tcs_statements WHERE period='2026-09'").get().status), "prepared");
});

// =============================================================================================
// F4 - the finance-scoped funeral read carried the pet
// =============================================================================================

test("F4 the finance screen renders the case without the pet, and can still identify it", async () => {
  const w = await world();
  const post = (payload) => funeralRoute.POST(new Request(`${HOST}/api/funeral-memorial`, { ...as(FOUNDER), method: "POST", body: JSON.stringify(payload) }));
  await post({ action: "save_service_config", serviceType: "cremation", enabled: true, baseAmount: 7500, cashAllowed: false });
  const created = await body(await post({ action: "create", customerId: "CUS-R3D", petName: "R3D-Simba", petSpecies: "dog", pickupAddress: "12 Residency Road, Bengaluru 560025", alternateContact: "+919812345678", serviceType: "cremation", memorialOption: "none" }));
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const caseId = created.json.data.id;

  // The engine still stores the pet - this is a projection defect, not a data-collection one.
  assert.equal(String(w.sqlite.prepare("SELECT pet_name FROM funeral_cases WHERE id=?").get(caseId).pet_name), "R3D-Simba");

  // The screen's own loader, against the REAL route, as the real `finance` role.
  globalThis.fetch = async (url, init) => funeralRoute.GET(new Request(new URL(String(url), HOST), { ...as(FINANCE), method: (init?.method || "GET") }));
  const React = (await import("react")).default;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const Page = (await import("../app/team/finance/funeral-memorial/page.tsx")).default;

  const cells = [];
  let cursor = 0;
  const pending = [];
  const dispatcher = {
    useState(initial) {
      const cell = cells[cursor++] ??= { value: typeof initial === "function" ? initial() : initial };
      return [cell.value, (next) => { cell.value = typeof next === "function" ? next(cell.value) : next; }];
    },
    useEffect(fn) { const cell = cells[cursor++] ??= {}; if (!cell.ran) { cell.ran = true; pending.push(fn); } },
    useMemo(fn) { const cell = cells[cursor++] ??= {}; if (!("value" in cell)) cell.value = fn(); return cell.value; },
    useCallback(fn) { return fn; },
    useRef(initial) { return cells[cursor++] ??= { current: initial }; },
  };
  dispatcher.useLayoutEffect = dispatcher.useEffect;
  const render = () => { const previous = internals.H; cursor = 0; internals.H = dispatcher; try { return Page(); } finally { internals.H = previous; } };
  render();
  for (const effect of pending) effect();
  for (let i = 0; i < 40; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  const html = renderToStaticMarkup(render());

  assert.ok(!html.includes("R3D-Simba"), "the pet's name must not be rendered to a role scoped without customer exposure");
  assert.ok(!html.includes("Residency Road"), "nor the pickup address");
  assert.ok(!html.includes("+919812345678"), "nor the alternate contact");
  assert.ok(!html.includes("CUS-R3D"), "nor the customer id");
  assert.ok(!html.includes("undefined"), "and nothing renders as the string 'undefined' where the pet used to be");
  assert.ok(html.includes(caseId), "but the screen must still name the case it is about");
  assert.ok(/\d{4}-\d{2}-\d{2}/.test(html), "and carry the dates that place it in a period");
  assert.ok(html.includes("cremation"), "and the service it is settling");
});
