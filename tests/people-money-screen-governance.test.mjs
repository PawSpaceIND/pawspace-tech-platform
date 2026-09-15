/**
 * People money-screen governance — executable regressions for four defects that all had the same
 * shape: a control that looks operable but cannot do what it appears to do, or a refusal the operator
 * is never allowed to read.
 *
 *   1. /team/people/incentives drew a dispute-resolution form — with a "Release for payment" checkbox —
 *      on EVERY incentive result, because `resolveDraft?.disputeId===dispute?.id` is `undefined===undefined`
 *      when there is neither a draft nor a dispute. Its Submit was a silent no-op (`if(!resolveDraft)return;`).
 *   2. The same screen offered "Reverse" on `calculated` results, which lib/incentive-engine.ts can only
 *      ever refuse (`WHERE id=? AND status='approved'`).
 *   3. /team/people/provider-training enabled "Save draft" on an empty form, and the resulting 400's real
 *      reason was redacted to "Unable to update provider training" because the thrown Response was ungoverned.
 *   4. lib/people-reports.ts turned a finite-but-out-of-range `?start=` into an unhandled RangeError → 500.
 *
 * Everything below EXECUTES the shipped code: the real page components are rendered with react-dom/server,
 * and the real engines run against a real SQLite-backed D1 shim. Nothing here matches on source text.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";

installWorkersHooks("__PEOPLE_MONEY_SCREEN_DB__");

// The shared harness resolves .ts/.tsx and stubs next/link and CSS modules. Two gaps remain for the
// provider-training page, both about its UI-kit import and neither about the code under test:
// `../../../components/ui` is a DIRECTORY (index.ts), which Node's ESM resolver does not fold in, and
// that barrel pulls recharts, whose CJS/redux chain cannot be linked from a synchronous resolve hook.
const RECHARTS_STUB = `data:text/javascript,${encodeURIComponent(
  ["ResponsiveContainer", "LineChart", "Line", "BarChart", "Bar", "XAxis", "YAxis", "CartesianGrid", "Tooltip", "Legend"]
    .map((name) => `export const ${name}=()=>null;`).join(""),
)}`;
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "recharts") return { url: RECHARTS_STUB, shortCircuit: true };
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
        for (const candidate of [`${specifier}/index.ts`, `${specifier}/index.tsx`]) {
          try { return nextResolve(candidate, context); } catch { /* try the next candidate */ }
        }
      }
      throw error;
    }
  },
});

const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const incentivesScreen = await import("../app/team/people/incentives/page.tsx");
const trainingScreen = await import("../app/team/people/provider-training/page.tsx");
const { ensureIncentiveTables, reverseIncentiveResult } = await import("../lib/incentive-engine.ts");
const { saveLmsModule } = await import("../lib/provider-lms.ts");
const { authError } = await import("../lib/server-auth.ts");
const { peopleReports } = await import("../lib/people-reports.ts");

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;
const noop = () => {};
const CARD_CALLBACKS = { onApprove: noop, onSubmitDispute: noop, onSubmitResolve: noop, onSubmitReverse: noop };
const result = (over = {}) => ({
  id: "IRES-1", employee_id: "EMP-1", employee_email: "priya@pawspace.in", metric_value: 120,
  calculated_amount: 8000, approved_amount: 0, status: "calculated", scheme_code: "SALES_BLR",
  version: 1, period_start: Date.UTC(2026, 7, 1), period_end: Date.UTC(2026, 7, 31), ...over,
});
const dispute = (over = {}) => ({ id: "IDSP-1", result_id: "IRES-1", status: "open", reason: "metric disputed by employee", opened_by: "priya@pawspace.in", opened_at: 1_700_000_000_000, ...over });
const renderCard = (props) => renderToStaticMarkup(React.createElement(incentivesScreen.IncentiveResultCard, {
  dispute: undefined, busy: false, disputeDraft: null, setDisputeDraft: noop,
  resolveDraft: null, setResolveDraft: noop, reverseDraft: null, setReverseDraft: noop,
  ...CARD_CALLBACKS, ...props,
}));

// ---- 1. The release-for-payment form only exists for a dispute actually being resolved --------------

test("no draft and no dispute draws no resolution form, no Submit and no release checkbox", () => {
  // The live reproduction: three results, zero disputes. Each one used to draw a full resolution form.
  const html = ["IRES-1", "IRES-2", "IRES-3"]
    .map((id) => renderCard({ result: result({ id }) }))
    .join("");
  assert.equal(occurrences(html, "Release for payment"), 0, "a result with no dispute must never offer to release money");
  assert.equal(occurrences(html, "Submit resolution"), 0, "and must never offer a Submit that submitResolve() discards");
  assert.equal(occurrences(html, "Resolution note"), 0);
  assert.equal(occurrences(html, 'type="checkbox"'), 0);
  assert.equal(incentivesScreen.resolveFormOpen(null, undefined), false, "the predicate the JSX uses says the same");
});

test("a disputed result whose draft is open still resolves - exactly one form, with its release control", () => {
  const open = dispute();
  const html = renderCard({
    result: result({ status: "disputed" }), dispute: open,
    resolveDraft: { disputeId: open.id, resolutionNote: "", release: false },
  });
  assert.equal(occurrences(html, "Release for payment"), 1, "the form the operator needs is still reachable");
  assert.equal(occurrences(html, "Submit resolution"), 1);
  assert.equal(occurrences(html, "Resolution note"), 1);
  assert.equal(incentivesScreen.resolveFormOpen({ disputeId: open.id }, open), true);
});

test("a draft open for ANOTHER dispute does not leak the form onto this result", () => {
  const mine = dispute({ id: "IDSP-MINE", result_id: "IRES-1" });
  const html = renderCard({
    result: result({ status: "disputed" }), dispute: mine,
    resolveDraft: { disputeId: "IDSP-SOMEONE-ELSE", resolutionNote: "note", release: true },
  });
  assert.equal(occurrences(html, "Release for payment"), 0);
  assert.equal(incentivesScreen.resolveFormOpen({ disputeId: "IDSP-SOMEONE-ELSE" }, mine), false);
});

test("resolveFormOpen treats absence as absence, never as a match", () => {
  for (const [draft, open] of [[null, undefined], [undefined, undefined], [null, null], [{ disputeId: "IDSP-1" }, undefined], [null, dispute()]]) {
    assert.equal(incentivesScreen.resolveFormOpen(draft, open), false, `${JSON.stringify(draft)} vs ${JSON.stringify(open)}`);
  }
  assert.equal(incentivesScreen.resolveFormOpen({ disputeId: "IDSP-1" }, dispute({ id: "IDSP-1" })), true);
});

// ---- 2. Reverse is offered exactly where the engine can honour it -----------------------------------

const REVERSAL = { amount: 100, reason: "clawback after audit finding", actorId: "manager@pawspace.in" };
const STATUSES = ["calculated", "held", "disputed", "approved", "reversed"];

async function seedResults(db, sqlite) {
  await ensureIncentiveTables(db);
  sqlite.prepare("INSERT INTO employee_incentive_periods (id,idempotency_key,scheme_id,period_start,period_end,status,calculated_by,created_at) VALUES ('IPER-1','k-1','ISV-1',?,?,'calculated','ops@pawspace.in',?)")
    .run(Date.UTC(2026, 7, 1), Date.UTC(2026, 7, 31), Date.now());
  for (const status of STATUSES) {
    sqlite.prepare("INSERT INTO employee_incentive_results (id,period_id,employee_id,employee_email,source_fact_run_id,metric_value,calculated_amount,approved_amount,status,evidence_json) VALUES (?,'IPER-1',?,?,'RUN-1',120,8000,8000,?,'{}')")
      .run(`IRES-${status}`, `EMP-${status}`, `${status}@pawspace.in`, status);
  }
}

test("Reverse is offered for exactly the statuses lib/incentive-engine.ts accepts", async () => {
  const { db, sqlite } = freshCountingD1();
  await seedResults(db, sqlite);

  async function engineAcceptsReversal(status) {
    try {
      await reverseIncentiveResult(db, { resultId: `IRES-${status}`, effectiveAt: Date.now(), ...REVERSAL });
      return true;
    } catch (error) {
      if (String(error?.message) === "Approved incentive result is required for reversal") return false;
      throw error;
    }
  }

  const accepted = [];
  for (const status of STATUSES) {
    const engine = await engineAcceptsReversal(status);
    if (engine) accepted.push(status);
    assert.equal(
      incentivesScreen.canReverseResult(status), engine,
      `the screen and the engine must agree about reversing a '${status}' result`,
    );
  }
  assert.deepEqual(accepted, ["approved"], "the engine's own rule, executed - only an approved result reverses");
});

test("the rendered Reverse button follows that rule", () => {
  const offered = (status) => />Reverse</.test(renderCard({ result: result({ status }) }));
  assert.equal(offered("approved"), true, "an approved result can be clawed back");
  for (const status of ["calculated", "held", "disputed", "reversed"]) {
    assert.equal(offered(status), false, `'${status}' must not be offered a control that can only fail`);
  }
});

// ---- 3a. Save draft is not live until the module can actually be saved ------------------------------

const VALID_DRAFT = {
  title: "Grooming safety SOP", summary: "Safety fundamentals for every grooming session",
  sections: "Check equipment\nConfirm pet comfort", question: "How long is the safety check before every session?",
  options: "Skip it|Five minutes minimum", answerIndex: "1", passPct: "80",
};
const toApiInput = (draft) => ({
  title: draft.title, serviceCode: "grooming", summary: draft.summary,
  sections: draft.sections.split("\n").map((section) => section.trim()).filter(Boolean),
  quiz: [{ question: draft.question, options: draft.options.split("|").map((option) => option.trim()).filter(Boolean), answerIndex: Number(draft.answerIndex) }],
  passPct: Number(draft.passPct), actorId: "staff:test",
});

test("the empty Author-a-module form renders a DISABLED Save draft and names what is missing", () => {
  const html = renderToStaticMarkup(React.createElement(trainingScreen.default));
  const save = html.match(/<button[^>]*>Save draft<\/button>/);
  assert.ok(save, "the Save draft button renders");
  assert.match(save[0], /disabled/, "and on an empty form it is disabled rather than firing a request that cannot succeed");
  const prose = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(prose, /still needs a title of at least 3 characters/, "the operator is told which field is missing");
  assert.match(prose, /a summary of at least 5 characters/);
  assert.match(prose, /at least one content section/);
  assert.match(prose, /a quiz question of at least 5 characters/);
  assert.match(prose, /at least two answer options/);
});

test("the Save gate agrees with the engine field by field, and a complete draft still round-trips", async () => {
  const { db } = freshCountingD1();
  assert.deepEqual(trainingScreen.missingModuleFields(VALID_DRAFT), [], "a complete draft is not blocked");
  const saved = await saveLmsModule(db, toApiInput(VALID_DRAFT));
  assert.ok(saved.moduleId, "and the API the enabled button calls still accepts it");
  assert.equal(saved.version, 1);
  assert.equal(saved.status, "draft");

  for (const field of ["title", "summary", "sections", "question", "options"]) {
    const draft = { ...VALID_DRAFT, [field]: "" };
    assert.ok(trainingScreen.missingModuleFields(draft).length > 0, `the screen blocks Save with an empty ${field}`);
    await assert.rejects(
      saveLmsModule(db, toApiInput(draft)),
      (error) => error instanceof Response && error.status === 400,
      `and the engine would have refused an empty ${field} anyway`,
    );
  }
});

// ---- 3b. A provider-LMS refusal reaches the operator with its real reason ---------------------------

test("a provider-LMS validation failure survives authError() with its own message", async () => {
  const { db } = freshCountingD1();
  const thrown = await saveLmsModule(db, toApiInput({ ...VALID_DRAFT, title: "" })).then(() => null, (error) => error);
  assert.ok(thrown instanceof Response, "validation still refuses by throwing a Response");
  assert.equal(thrown.status, 400);

  // The real redaction path: this is exactly what app/api/provider-lms/route.ts does in its catch.
  const governed = authError(thrown, "Unable to update provider training");
  assert.equal(governed.status, 400);
  assert.equal((await governed.json()).error, "Module title is required", "the operator reads the real reason");

  const scope = await saveLmsModule(db, { ...toApiInput(VALID_DRAFT), serviceCode: "not-a-service" }).then(() => null, (error) => error);
  assert.equal((await authError(scope, "Unable to update provider training").json()).error, "Module service scope must be 'all' or a real service code");
});

test("control: an ungoverned thrown Response is still redacted, so the test above proves governance", async () => {
  const redacted = authError(new Response("Module title is required", { status: 400 }), "Unable to update provider training");
  assert.equal(redacted.status, 400);
  assert.equal((await redacted.json()).error, "Unable to update provider training");
});

// ---- 4. Out-of-range report periods fall back instead of 500ing -------------------------------------

const MAX_TIME_VALUE_MS = 8_640_000_000_000_000;
const REPORT_ACTOR = { actorEmail: "ops@pawspace.in", roleCode: "people_ops", permissions: ["people.manage"] };
const defaultStartOfMonth = () => { const now = new Date(); return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1); };

test("the proven boundary still answers, and one millisecond past it falls back instead of throwing", async () => {
  const { db } = freshCountingD1();
  const boundary = await peopleReports(db, { ...REPORT_ACTOR, periodStart: MAX_TIME_VALUE_MS });
  assert.equal(boundary.period.start, MAX_TIME_VALUE_MS, "?start=8640000000000000 is accepted, as it always was");

  const past = await peopleReports(db, { ...REPORT_ACTOR, periodStart: MAX_TIME_VALUE_MS + 1 });
  assert.equal(past.period.start, defaultStartOfMonth(), "?start=8640000000000001 falls back to the default period");
  assert.equal(past.period.startDate, new Date(defaultStartOfMonth()).toISOString().slice(0, 10));
});

test("every out-of-range period bound degrades to the default the way a non-finite one does", async () => {
  const { db } = freshCountingD1();
  const nonFinite = await peopleReports(db, { ...REPORT_ACTOR, periodStart: Number.NaN, periodEnd: Number.NaN });
  for (const periodStart of [MAX_TIME_VALUE_MS + 1, -MAX_TIME_VALUE_MS - 1, 1e300, Number.MAX_VALUE]) {
    const report = await peopleReports(db, { ...REPORT_ACTOR, periodStart });
    assert.equal(report.period.start, nonFinite.period.start, `periodStart=${periodStart} behaves like a non-finite bound`);
    assert.match(report.period.startDate, /^\d{4}-\d{2}-\d{2}$/);
  }
  for (const periodEnd of [MAX_TIME_VALUE_MS + 1, 1e300, Number.MAX_VALUE]) {
    const report = await peopleReports(db, { ...REPORT_ACTOR, periodStart: Date.UTC(2026, 0, 1), periodEnd });
    assert.ok(report.period.end <= Date.now(), `periodEnd=${periodEnd} falls back to now`);
    assert.match(report.period.endDate, /^\d{4}-\d{2}-\d{2}$/);
  }
});
