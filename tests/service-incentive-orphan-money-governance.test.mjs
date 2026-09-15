/**
 * Service-incentive money that belongs to nobody — executable regressions for three defects that all
 * end in the same place: a row of money written against an EMPTY employee id, and an operator told
 * it was saved.
 *
 *   1. POST /api/service-incentives `save_groomer_target` and `save_gpay_ledger` validated the month
 *      and the amounts but never the person. headGroomerId:"" answered 200 and wrote
 *      groomer_monthly_targets / groomer_gpay_ledger rows with head_groomer_id=''. The gpay response
 *      even computed a Rs 1,250 pending fine for nobody. `save_groomer_bracket` and
 *      `record_groomer_special_incentive` already refused a blank id; the rule simply was not applied
 *      to the other twenty actions.
 *   2. /team/people/service-incentives drew one form per card but wired them to each other: the
 *      bracket card posted `effectiveFrom` from the UNRELATED lookup panel's month, and target /
 *      gpay / special / draft / finalize all read headGroomerId from the BRACKET card. Filling in
 *      only the card in front of you posted headGroomerId:"" — which is how defect 1 was reached.
 *   3. No button on the screen had a busy state, so a double-clicked "Save bracket" wrote two rows
 *      and the engine closed the first with effective_until = the day it began.
 *
 * Everything below EXECUTES the shipped code: the real POST handler runs against a real
 * SQLite-backed D1 shim, and the real page component is rendered with react-dom/server.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";

// The route runs as the explicitly triple-gated local preview actor (people.manage granted), exactly
// like every other suite that drives a real handler.
installWorkersHooks("__SERVICE_INCENTIVE_MONEY_DB__", "__SERVICE_INCENTIVE_MONEY_ENV__");
delete process.env.PAWSPACE_DEPLOYMENT_ENV;

const route = await import("../app/api/service-incentives/route.ts");
const screen = await import("../app/team/people/service-incentives/page.tsx");
const { authError } = await import("../lib/server-auth.ts");
const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");

const MONEY_TABLES = [
  "groomer_monthly_targets", "groomer_gpay_ledger", "groomer_incentive_brackets",
  "groomer_special_incentives", "groomer_offline_sub_sales", "groomer_incentive_results",
];

function world() {
  const harness = freshCountingD1();
  globalThis.__SERVICE_INCENTIVE_MONEY_DB__ = harness.db;
  globalThis.__SERVICE_INCENTIVE_MONEY_ENV__ = {};
  return harness;
}

const post = (body) => route.POST(new Request("http://localhost/api/service-incentives", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));

const rows = (sqlite, table) => sqlite.prepare(`SELECT * FROM ${table}`).all();
const countAllMoney = (sqlite) => MONEY_TABLES.reduce((total, table) => total + rows(sqlite, table).length, 0);

/** Every spelling of "nobody" a form can produce. */
const BLANK_IDS = ["", "   ", "\t\n ", undefined, null];

// ---- 1. A money write with no employee is refused, with its real reason, and writes nothing -------

test("save_groomer_target refuses every blank head groomer, says why, and writes no row", async () => {
  const { sqlite } = world();
  for (const headGroomerId of BLANK_IDS) {
    const response = await post({ action: "save_groomer_target", headGroomerId, monthStart: "2026-08-01", targetAmount: 999999, reason: "Monthly target published" });
    assert.equal(response.status, 400, `headGroomerId ${JSON.stringify(headGroomerId)} must be refused, not saved`);
    const body = await response.json();
    assert.equal(body.error, "Head groomer is required", "the operator reads the real reason, not a generic fallback");
    assert.equal(body.field, "headGroomerId");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(rows(sqlite, "groomer_monthly_targets"), [], "a published target must never exist without an owner");
  }
  assert.equal(countAllMoney(sqlite), 0, "no money table may carry a row from a refused request");
});

test("save_gpay_ledger refuses every blank head groomer - and computes no fine for nobody", async () => {
  const { sqlite } = world();
  for (const headGroomerId of BLANK_IDS) {
    const response = await post({ action: "save_gpay_ledger", headGroomerId, monthStart: "2026-08-01", gpayTotal: 15000, gpayPending: 12000 });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "Head groomer is required");
    assert.equal(body.fine, undefined, "the refusal must not carry the Rs 1,250 pending fine the 200 used to report");
    assert.deepEqual(rows(sqlite, "groomer_gpay_ledger"), []);
  }
  assert.equal(countAllMoney(sqlite), 0);
});

test("the two actions that already refused a blank id still do, now as a 4xx the operator can read", async () => {
  const { sqlite } = world();
  const bracket = await post({ action: "save_groomer_bracket", headGroomerId: "  ", bracket: "single", effectiveFrom: "2026-08-01", reason: "Single groomer for August" });
  assert.equal(bracket.status, 400, "a blank id was refused before - but as a 500 generic");
  assert.equal((await bracket.json()).error, "Head groomer is required");

  const special = await post({ action: "record_groomer_special_incentive", headGroomerId: "", monthStart: "2026-08-01", amount: 1500, reason: "Rescued a matted dog" });
  assert.equal(special.status, 400);
  assert.equal((await special.json()).error, "Head groomer is required");
  assert.equal(countAllMoney(sqlite), 0);
});

test("every action that names a person refuses a blank one, and none of them writes", async () => {
  const { sqlite } = world();
  const FIELD_OF = {
    headGroomerId: ["save_groomer_bracket", "save_groomer_target", "record_offline_sub_sale", "save_gpay_ledger",
      "record_groomer_special_incentive", "save_groomer_incentive_draft", "finalize_groomer_incentive"],
    helperId: ["record_helper_attendance"],
    trainerId: ["record_meet_greet_conversion"],
    employeeId: ["save_sales_base", "attribute_booking", "compute_daily_sales", "generate_sales_period",
      "approve_sales_period", "record_special_incentive", "record_review_incentive"],
    providerId: ["save_home_base", "home_base_history", "compute_daily_travel", "daily_travel_summary"],
  };
  const covered = Object.values(FIELD_OF).flat();
  assert.deepEqual([...covered].sort(), [...route.identifiedSubjectActions()].sort(),
    "the route's guard table and this test must name exactly the same actions");

  for (const [field, actions] of Object.entries(FIELD_OF)) {
    for (const action of actions) {
      const response = await post({ action, [field]: "   ", monthStart: "2026-08-01", date: "2026-08-10", amount: 1000, targetAmount: 1000, reason: "A real reason for this" });
      assert.equal(response.status, 400, `${action} must refuse a whitespace-only ${field}`);
      const body = await response.json();
      assert.match(String(body.error), /is required$/, `${action} must say what is missing`);
      assert.equal(body.field, field);
    }
  }
  // rank_groomers takes a LIST of people; one blank entry ranks nobody against everybody else.
  const ranked = await post({ action: "rank_groomers", monthStart: "2026-08-01", headGroomerIds: ["GRM-1", ""] });
  assert.equal(ranked.status, 400);
  assert.equal((await ranked.json()).error, "Head groomer is required");

  assert.equal(countAllMoney(sqlite), 0, "twenty-one refusals, zero rows");
});

// ---- 2. The refusal survives the route's catch with its own message ------------------------------

test("a governed refusal keeps its reason through authError; an ungoverned one is still redacted", async () => {
  const { sqlite } = world();
  const real = await post({ action: "save_groomer_target", headGroomerId: "", monthStart: "2026-08-01", targetAmount: 145000, reason: "Monthly target published" });
  assert.equal((await real.json()).error, "Head groomer is required");
  assert.equal(rows(sqlite, "groomer_monthly_targets").length, 0);

  // The control: this is what a bare `throw new Response(...)` would have produced from the same catch.
  const originalError = console.error;
  console.error = () => {};
  try {
    const redacted = authError(Response.json({ error: "Head groomer is required" }, { status: 400 }), "Unable to update service incentive engine");
    assert.equal(redacted.status, 400);
    assert.equal((await redacted.json()).error, "Unable to update service incentive engine",
      "an ungoverned thrown Response loses its body - which is why the guard uses governedJsonError");
  } finally {
    console.error = originalError;
  }
});

// ---- 3. A named employee still writes, exactly as before -----------------------------------------

test("a real head groomer still publishes a target and a gpay ledger", async () => {
  const { sqlite } = world();
  const target = await post({ action: "save_groomer_target", headGroomerId: "GRM-REAL", monthStart: "2026-08-01", targetAmount: 145000, reason: "Monthly target published" });
  assert.equal(target.status, 200);
  assert.deepEqual(await target.json(), { headGroomerId: "GRM-REAL", monthStart: "2026-08-01", targetAmount: 145000 });
  const saved = rows(sqlite, "groomer_monthly_targets");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].head_groomer_id, "GRM-REAL");
  assert.equal(saved[0].target_amount, 145000);

  const gpay = await post({ action: "save_gpay_ledger", headGroomerId: "GRM-REAL", monthStart: "2026-08-01", gpayTotal: 15000, gpayPending: 12000 });
  assert.equal(gpay.status, 200);
  assert.deepEqual(await gpay.json(), { headGroomerId: "GRM-REAL", monthStart: "2026-08-01", gpayTotal: 15000, gpayPending: 12000, fine: 1250 });
  const ledger = rows(sqlite, "groomer_gpay_ledger");
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].head_groomer_id, "GRM-REAL");

  const bracket = await post({ action: "save_groomer_bracket", headGroomerId: "GRM-REAL", bracket: "single", effectiveFrom: "2026-08-01", reason: "Single groomer for August" });
  assert.equal(bracket.status, 200);
  assert.equal(rows(sqlite, "groomer_incentive_brackets")[0].head_groomer_id, "GRM-REAL");
});

test("a real employee is still accepted with surrounding whitespace trimmed away by the form", async () => {
  const { sqlite } = world();
  // The screen trims before it posts; the API accepts the trimmed value and nothing else changes.
  const body = screen.targetBody({ headGroomerId: "  GRM-REAL  ", monthStart: " 2026-08-01 ", targetAmount: "145000" });
  assert.deepEqual(body, { headGroomerId: "GRM-REAL", monthStart: "2026-08-01", targetAmount: 145000, reason: "Monthly target published" });
  const response = await post({ action: "save_groomer_target", ...body });
  assert.equal(response.status, 200);
  assert.equal(rows(sqlite, "groomer_monthly_targets")[0].head_groomer_id, "GRM-REAL");
});

// ---- 4. Each card reads its OWN inputs ------------------------------------------------------------

const pageHtml = () => renderToStaticMarkup(React.createElement(screen.default));
const sectionsOf = (html) => html.split("<section").slice(1).map((part) => `<section${part.split("</section>")[0]}`);
const cardWith = (html, heading) => {
  const found = sectionsOf(html).find((part) => part.includes(heading));
  assert.ok(found, `the card headed "${heading}" must still render`);
  return found;
};

test("the bracket card carries its OWN effective-from date, not the lookup panel's month", () => {
  const html = pageHtml();
  const bracket = cardWith(html, "Set bracket");
  const lookup = cardWith(html, "Look up a real monthly breakdown");

  assert.match(bracket, /name="bracket-effective-from"/, "the bracket card owns the date it takes effect from");
  assert.match(bracket, /Effective from \(YYYY-MM-01\)/, "and the operator can see which date that is");
  assert.doesNotMatch(bracket, /name="lookup-month"/, "the unrelated lookup panel's month is not part of this card");
  assert.match(lookup, /name="lookup-month"/);
  assert.doesNotMatch(lookup, /name="bracket-effective-from"/);

  // Executed, not read: the request body is a pure function of the bracket card's own fields.
  assert.deepEqual(
    screen.bracketBody({ headGroomerId: "GRM-1", bracket: "single", helperId: "", effectiveFrom: "2026-08-01", reason: "Single groomer for August" }),
    { headGroomerId: "GRM-1", bracket: "single", helperId: null, effectiveFrom: "2026-08-01", reason: "Single groomer for August" },
  );
});

test("every groomer money card carries its own employee and its own month", () => {
  const html = pageHtml();
  const OWN_FIELDS = [
    ["Monthly target", ["target-head", "target-month", "target-amount"]],
    ["Gpay collection", ["gpay-head", "gpay-month", "gpay-total", "gpay-pending"]],
    ["One-time special incentive", ["special-head", "special-month", "special-amount", "special-reason"]],
    ["Monthly incentive review", ["review-head", "review-month"]],
    ["Helper attendance", ["attendance-helper", "attendance-date"]],
  ];
  for (const [heading, fields] of OWN_FIELDS) {
    const card = cardWith(html, heading);
    for (const field of fields) assert.match(card, new RegExp(`name="${field}"`), `"${heading}" must own its ${field} input`);
    assert.doesNotMatch(card, /name="bracket-head"/, `"${heading}" must not borrow the bracket card's employee`);
    assert.doesNotMatch(card, /name="lookup-month"/, `"${heading}" must not borrow the lookup panel's month`);
  }
});

test("each card's request body is built from that card alone", () => {
  assert.deepEqual(screen.gpayBody({ headGroomerId: "GRM-2", monthStart: "2026-09-01", gpayTotal: "15000", gpayPending: "12000" }),
    { headGroomerId: "GRM-2", monthStart: "2026-09-01", gpayTotal: 15000, gpayPending: 12000 });
  assert.deepEqual(screen.specialBody({ headGroomerId: "GRM-3", monthStart: "2026-09-01", amount: "1500", reason: "Rescued a matted dog" }),
    { headGroomerId: "GRM-3", monthStart: "2026-09-01", amount: 1500, reason: "Rescued a matted dog" });
  assert.deepEqual(screen.reviewBody({ headGroomerId: "GRM-4", monthStart: "2026-09-01" }), { headGroomerId: "GRM-4", monthStart: "2026-09-01" });
  assert.deepEqual(screen.attendanceBody({ helperId: "HLP-1", attendanceDate: "2026-08-10", status: "absent" }),
    { helperId: "HLP-1", attendanceDate: "2026-08-10", status: "absent" });
});

test("an empty form cannot submit a blank employee id at all", () => {
  const html = pageHtml();
  const buttons = html.match(/<button[^>]*>[^<]*<\/button>/g) ?? [];
  for (const labelText of ["Save target", "Save Gpay ledger", "Record special incentive", "Save incentive draft", "Finalize reviewed incentive", "Save bracket", "Record attendance"]) {
    const button = buttons.find((candidate) => candidate.includes(`>${labelText}<`));
    assert.ok(button, `${labelText} must still render`);
    assert.match(button, /disabled/, `${labelText} must not be firable while its card names nobody`);
  }
  assert.match(html, /Still needs Head Groomer ID/, "and the operator is told which field is missing");
  assert.deepEqual(screen.missingFields({ "Head Groomer ID": "   ", "Month": "2026-08-01" }), ["Head Groomer ID"],
    "whitespace is blank, the same way the API reads it");
});

// ---- 5. A double click cannot write twice --------------------------------------------------------

const renderButton = ({ label: buttonLabel = "Save bracket", ...props } = {}) => renderToStaticMarkup(React.createElement(
  screen.ActionButton,
  { action: "save_groomer_bracket", busy: "", missing: [], onRun: () => {}, ...props },
  buttonLabel,
));

test("a control with work in flight is disabled and says so", () => {
  const idle = renderButton({});
  assert.doesNotMatch(idle, /disabled/, "a complete card with nothing in flight is operable");
  assert.match(idle, />Save bracket</);

  const inFlight = renderButton({ busy: "save_groomer_bracket" });
  assert.match(inFlight, /disabled/, "the second click of a double-click has nothing to press");
  assert.match(inFlight, />Saving…</, "and the operator can see why");

  const otherInFlight = renderButton({ busy: "save_groomer_target" });
  assert.match(otherInFlight, /disabled/, "any write in flight locks every money control, not just its own");
  assert.match(otherInFlight, />Save bracket</, "a control that is not the one running keeps its own label");

  const incomplete = renderButton({ missing: ["Head Groomer ID"] });
  assert.match(incomplete, /disabled/);
  assert.match(incomplete, /Still needs Head Groomer ID/);
});

test("two bracket writes for the same groomer are the operator's choice, never a stray double click", async () => {
  const { sqlite } = world();
  const body = screen.bracketBody({ headGroomerId: "GRM-DOUBLE", bracket: "single", helperId: "", effectiveFrom: "2026-08-01", reason: "Single groomer for August" });
  await post({ action: "save_groomer_bracket", ...body });
  await post({ action: "save_groomer_bracket", ...body });
  // The engine's own behaviour, pinned so the UI guard's reason is visible: the second write closes
  // the first on the day it began. That is what the disabled state exists to prevent.
  const saved = rows(sqlite, "groomer_incentive_brackets");
  assert.equal(saved.length, 2);
  assert.equal(saved[0].effective_until, "2026-08-01", "the first bracket was closed the day it opened");
  assert.equal(saved[1].effective_until, null);
});
