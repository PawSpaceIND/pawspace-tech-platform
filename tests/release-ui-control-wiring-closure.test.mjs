import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CONTROL_RESULT, classifyControl, isControlFailure, summariseControlResults } from "../scripts/release-ui-control-classifier.mjs";

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
const harness = read("../scripts/release-ui-closure.mjs");
const classifier = read("../scripts/release-ui-control-classifier.mjs");

const NOTHING = { destructive: false, mutationAttempt: null, requestSeen: null, dialogSeen: null, navigationSeen: null, changed: false, validationBlocked: null, displacement: null, error: null };

// ---------------------------------------------------------------------------
// Root cause 1 - a control already in its selected state writes the state it
// already holds, React bails out, and nothing is committed. Release UI closure
// #17 reported 7 such controls as unwired.
// ---------------------------------------------------------------------------

test("an already-active control that commits a change once its state is displaced counts as wired", () => {
  const result = classifyControl({ ...NOTHING, displacement: { attempted: true, changed: true, sibling: "Queued", evidence: "dom mutations 12" } });
  assert.equal(result, CONTROL_RESULT.wiredIdempotent);
  assert.equal(isControlFailure(result), false);
});

test("a control that stays inert even after its state is displaced remains a failure", () => {
  const result = classifyControl({ ...NOTHING, displacement: { attempted: true, changed: false, sibling: "Queued", evidence: null } });
  assert.equal(result, CONTROL_RESULT.noObservableEffect);
  assert.equal(isControlFailure(result), true, "the displaced re-probe must not become a blanket pass");
});

test("state can be displaced through a sibling field, not only a sibling button", () => {
  // /team/ai/analytics Clear sits with a <select> and two date <input>s and no sibling button, so
  // button-only displacement could never reach it.
  assert.match(harness, /querySelectorAll\("select"\)/);
  assert.match(harness, /querySelectorAll\("input"\)/);
  assert.match(harness, /async function displaceField/);
  assert.match(harness, /Object\.getOwnPropertyDescriptor\(prototype, "value"\)\?\.set/, "React's value tracker requires the native setter");
  assert.match(harness, /new Event\("input", \{ bubbles: true \}\)/);
  const result = classifyControl({ ...NOTHING, displacement: { attempted: true, changed: true, sibling: "select channel", kind: "select", evidence: "dom mutations 3" } });
  assert.equal(result, CONTROL_RESULT.wiredIdempotent);
});

test("field displacement runs inside the same mutation-blocking guard as a click", () => {
  assert.match(harness, /async function withMutationBlocking/);
  assert.match(harness, /withMutationBlocking\(page, \(\) => displaceField\(page, candidate\)\)/);
});

test("a control with no sibling to displace against is still judged on its own evidence", () => {
  const result = classifyControl({ ...NOTHING, displacement: { attempted: false, changed: false, sibling: null, evidence: null } });
  assert.equal(result, CONTROL_RESULT.noObservableEffect);
  assert.equal(isControlFailure(result), true);
});

// ---------------------------------------------------------------------------
// Root cause 2 - a submit control on a pristine form cannot navigate, request
// or mutate because constraint validation stops submission first. Closure #17
// reported 4 such controls as unwired.
// ---------------------------------------------------------------------------

test("constraint validation firing for the control's own form counts as wiring evidence", () => {
  const result = classifyControl({ ...NOTHING, validationBlocked: { form: true, fields: ["packagecode", "name"] } });
  assert.equal(result, CONTROL_RESULT.wiredValidationBlocked);
  assert.equal(isControlFailure(result), false);
});

test("constraint validation on some other form is not evidence for this control", () => {
  const result = classifyControl({ ...NOTHING, validationBlocked: { form: false, fields: ["unrelated"] } });
  assert.equal(result, CONTROL_RESULT.noObservableEffect);
  assert.equal(isControlFailure(result), true);
});

test("the probe only records invalid events raised inside the clicked control's own form", () => {
  assert.match(harness, /sameForm: Boolean\(window\.__pawspaceProbeForm && field\.form === window\.__pawspaceProbeForm\)/);
  assert.match(harness, /\(window\.__pawspaceInvalid \|\| \[\]\)\.filter\(\(item\) => item\.sameForm\)/);
});

// ---------------------------------------------------------------------------
// Root cause 3 - a provider-identity surface refuses a staff UAT session. That
// is recorded as route context ONLY. It is never a verdict, because a verdict
// would exempt every no-effect control on the route, including one that is
// genuinely wired to nothing and merely sits next to a background 401.
// ---------------------------------------------------------------------------

test("there is no identity or authorisation exemption in the classifier at all", () => {
  assert.equal(Object.values(CONTROL_RESULT).includes("blocked_identity_precondition"), false);
  for (const key of Object.keys(CONTROL_RESULT)) {
    assert.doesNotMatch(key, /identity|auth|permission|rbac/i, `${key} must not be an identity exemption`);
  }
  assert.doesNotMatch(classifier, /identityGated|blocked_identity_precondition/, "the classifier must carry no identity branch");
});

test("NEGATIVE REGRESSION: a background 401 must not rescue an unrelated inert control", () => {
  // Same route, same page, same background identity refusal: one control produces evidence, the
  // other is genuinely wired to nothing. The inert one must still fail.
  const inert = classifyControl({
    ...NOTHING,
    identityRefused: "HTTP 401 /api/identity-session",
    identityGated: true,
    blockedByIdentity: true,
    displacement: { attempted: true, changed: false, sibling: "Some sibling", evidence: null },
  });
  assert.equal(inert, CONTROL_RESULT.noObservableEffect, "identity context must not change the verdict");
  assert.equal(isControlFailure(inert), true, "an inert control on a 401 route must still fail the gate");

  const wired = classifyControl({ ...NOTHING, identityRefused: "HTTP 401 /api/identity-session", changed: true });
  assert.equal(wired, CONTROL_RESULT.wired, "a control that does work is still wired on a 401 route");
});

test("stray identity-shaped evidence keys can never produce a passing verdict", () => {
  for (const key of ["identityGated", "identityRefused", "blockedByIdentity", "authRefused", "rbacBlocked"]) {
    const verdict = classifyControl({ ...NOTHING, [key]: true });
    assert.equal(isControlFailure(verdict), true, `${key} must not exempt a no-effect control`);
  }
});

test("identity refusal is reported as route context, separately from any verdict", () => {
  assert.match(harness, /identityRefusedRoutes:/);
  assert.match(harness, /Informational only\. An unmet identity precondition never exempts a control/);
  assert.match(harness, /\[401, 403\]\.includes\(response\.status\(\)\)/);
});

// ---------------------------------------------------------------------------
// Route serviceability - a Cloudflare edge error page is not PawSpace, and its
// controls must never enter PawSpace coverage.
// ---------------------------------------------------------------------------

test("an unserviceable route fails explicitly as route_unavailable", () => {
  const verdict = classifyControl({ ...NOTHING, routeUnavailable: true });
  assert.equal(verdict, CONTROL_RESULT.routeUnavailable);
  assert.equal(isControlFailure(verdict), true, "an unreachable route must never look like a clean route");
});

test("route_unavailable outranks every other signal, including apparent evidence", () => {
  const verdict = classifyControl({ ...NOTHING, routeUnavailable: true, changed: true, requestSeen: "GET /api/x" });
  assert.equal(verdict, CONTROL_RESULT.routeUnavailable);
});

test("route loading is validated as a real PawSpace document before controls are snapshotted", () => {
  assert.match(harness, /async function loadRouteForProbe/);
  assert.match(harness, /pawspaceDocument/);
  assert.match(harness, /classList\.contains\("antialiased"\)/);
  assert.match(harness, /meta\[name="codex-preview"\]/);
  // The descriptor snapshot must come from a validated load, not a raw goto.
  const probe = harness.slice(harness.indexOf("async function probeControls"));
  const snapshotAt = probe.indexOf("const descriptors =");
  const loadAt = probe.indexOf("const load = await loadRouteForProbe(page, route);");
  assert.ok(loadAt >= 0 && loadAt < snapshotAt, "the route must be validated before the descriptor snapshot");
});

test("a 5xx or Cloudflare error page is retried a bounded number of times, at most two retries", () => {
  assert.match(harness, /const ROUTE_LOAD_ATTEMPTS = 3;/, "one initial load plus at most two retries");
  assert.match(harness, /for \(let attempt = 1; attempt <= ROUTE_LOAD_ATTEMPTS; attempt \+= 1\)/);
  assert.match(harness, /status < 500/);
  assert.match(harness, /cloudflareError/);
});

test("Cloudflare edge-error controls are excluded from PawSpace control coverage", () => {
  assert.match(harness, /cloudflareChrome: Boolean\(el\.closest\(selector\)\)/);
  assert.match(harness, /!d\.cloudflareChrome/, "Cloudflare controls must be filtered out of the probe targets");
  assert.match(harness, /cloudflareControlsExcluded:/, "the excluded count must be reported");
  assert.match(harness, /CF_ERROR_SELECTOR/);
});

test("Cloudflare detection keys off edge markers, not words the product may legitimately use", () => {
  const marker = harness.match(/const CF_ERROR_TEXT = \/\((.*?)\)\/i;/)?.[1] || "";
  assert.ok(marker.length > 0, "Cloudflare error text pattern must exist");
  assert.doesNotMatch(marker, /\|cloudflare\)|^cloudflare$/i, "a bare 'cloudflare' match would flag legitimate product copy");
  for (const needed of ["worker threw exception", "cloudflare ray id"]) {
    assert.ok(marker.toLowerCase().includes(needed), `${needed} must be one of the edge markers`);
  }
});

test("genuine index_drift stays a failure for a real PawSpace control", () => {
  const verdict = classifyControl({ ...NOTHING, indexDrift: true });
  assert.equal(verdict, CONTROL_RESULT.indexDrift);
  assert.equal(isControlFailure(verdict), true);
  // and it must not be reachable by simply waiting: the harness has no blind polling retry
  assert.doesNotMatch(harness, /for \(let poll = 0; poll < \d+; poll/, "drift must not be papered over by blind polling");
});

// ---------------------------------------------------------------------------
// The gate must not have been weakened.
// ---------------------------------------------------------------------------

test("absence of evidence is still a failure", () => {
  assert.equal(classifyControl(NOTHING), CONTROL_RESULT.noObservableEffect);
  assert.equal(isControlFailure(CONTROL_RESULT.noObservableEffect), true);
  assert.equal(isControlFailure(CONTROL_RESULT.clickError), true);
  assert.equal(isControlFailure(CONTROL_RESULT.indexDrift), true);
});

test("a control existing is never sufficient on its own", () => {
  for (const evidence of [{}, { destructive: true }, { changed: false }, { domMutations: 0 }]) {
    assert.equal(isControlFailure(classifyControl(evidence)), true, `bare evidence ${JSON.stringify(evidence)} must not pass`);
  }
});

test("direct observable effects still classify as wired", () => {
  for (const key of ["navigationSeen", "requestSeen", "dialogSeen"]) {
    assert.equal(classifyControl({ ...NOTHING, [key]: "something" }), CONTROL_RESULT.wired);
  }
  assert.equal(classifyControl({ ...NOTHING, changed: true }), CONTROL_RESULT.wired);
});

test("a destructive control proven only by an aborted mutating request keeps its own verdict", () => {
  const result = classifyControl({ ...NOTHING, destructive: true, mutationAttempt: "POST /api/catalogue" });
  assert.equal(result, CONTROL_RESULT.wiredMutationBlocked);
  assert.equal(isControlFailure(result), false);
});

test("a click that threw is a failure rather than a silent pass", () => {
  assert.equal(classifyControl({ ...NOTHING, error: "locator.click: Timeout 3500ms exceeded" }), CONTROL_RESULT.clickError);
});

test("a control the probe could not re-resolve is a failure, never assumed wired", () => {
  const result = classifyControl({ ...NOTHING, indexDrift: true, changed: true });
  assert.equal(result, CONTROL_RESULT.indexDrift);
  assert.equal(isControlFailure(result), true, "an unidentifiable control must not borrow another control's evidence");
});

test("a destructive control is never clicked a second time to manufacture evidence", () => {
  assert.match(harness, /const needsDisplacement = !observable\(evidence\) && !evidence\.validationBlocked && !evidence\.error && !destructive;/);
});

test("mutating requests stay blocked during the displaced-state re-probe", () => {
  // Every interaction, primary click and displacement alike, is wrapped by the single guard that
  // aborts mutating requests before execution.
  const guard = harness.slice(harness.indexOf("async function withMutationBlocking"), harness.indexOf("async function clickAndObserve"));
  assert.match(guard, /MUTATING_METHODS\.has\(method\)/, "the shared guard aborts mutating methods");
  assert.match(guard, /routeHandle\.abort\("blockedbyclient"\)/);
  assert.match(harness, /mutationsExecuted: 0/);
  // displacedStateProbe must reach the browser only through guarded helpers.
  const probe = harness.slice(harness.indexOf("async function displacedStateProbe"), harness.indexOf("async function probeControls"));
  assert.doesNotMatch(probe, /locator\([^)]*\)\.click|\.click\(\{/, "the re-probe must not click outside the mutation-blocking helper");
  assert.match(probe, /clickAndObserve|withMutationBlocking/, "displacement interacts only through guarded helpers");
});

test("the gate still fails the run on any control failure", () => {
  assert.match(harness, /if \(report\.summary\.controlFailures\) \{/);
  assert.match(harness, /process\.exitCode = 1/);
  assert.match(harness, /isControlFailure\(c\.result\)/);
});

test("summary counting reports every non-plain verdict so exemptions cannot grow unseen", () => {
  const summary = summariseControlResults([
    { result: CONTROL_RESULT.wired },
    { result: CONTROL_RESULT.wiredIdempotent },
    { result: CONTROL_RESULT.wiredValidationBlocked },
    { result: CONTROL_RESULT.routeUnavailable },
    { result: CONTROL_RESULT.noObservableEffect },
    { result: CONTROL_RESULT.indexDrift },
  ]);
  assert.equal(summary.probed, 6);
  assert.equal(summary.failures, 3);
  assert.equal(summary.byResult[CONTROL_RESULT.wiredIdempotent], 1);
  assert.equal(summary.byResult[CONTROL_RESULT.routeUnavailable], 1);
  for (const field of ["controlsIdempotentProven", "controlsValidationBlocked", "controlsRouteUnavailable", "cloudflareControlsExcluded", "identityRefusedRoutes", "routesRetriedForLoad"]) {
    assert.match(harness, new RegExp(`${field}:`), `${field} must appear in the run summary`);
  }
  assert.doesNotMatch(harness, /controlsIdentityGated/, "the removed identity exemption must not reappear in the summary");
});

test("the closure gate never resorts to hiding overflow or to visual edits", () => {
  assert.doesNotMatch(classifier, /overflow-x/i);
  assert.doesNotMatch(harness, /overflow-x\s*:\s*hidden/i);
});

// ---------------------------------------------------------------------------
// Product-side invariants behind the two false-positive classes. These are the
// facts that make each flagged control a correct no-op; if one drifts, the
// control's default state really is broken and this must fail.
// ---------------------------------------------------------------------------

const DEFAULT_SELECTED_CONTROLS = [
  { file: "../app/team/subscription-plans/page.tsx", label: "All services", state: /useState\("all"\)/, option: /setService\("all"\)/ },
  { file: "../app/team/cases/page.tsx", label: "Open", state: /useState\("open"\)/, option: /\["open","Open"\]/ },
  { file: "../app/team/customer-reminders/page.tsx", label: "All", state: /useState\("all"\)/, option: /\["all", "All"\]/ },
  { file: "../app/booking-command-center/page.tsx", label: "All bookings", state: /useState\("All bookings"\)/, option: /"All bookings", "Needs attention"/ },
  { file: "../app/team/performance/page.tsx", label: "30 days", state: /useState\(30\)/, option: /\[7,30,90\]\.map/ },
  { file: "../app/team/people/service-incentives/page.tsx", label: "groomer", state: /useState<Kind>\("groomer"\)/, option: /\["groomer", "trainer", "sales"\]/ },
  { file: "../app/partner-app/page.tsx", label: "Home", state: /useState<Tab>\("home"\)/, option: /"home", "⌂", "Home"/ },
  { file: "../app/partner-mobile/page.tsx", label: "Home", state: /useState<Tab>\("home"\)/, option: /\["home","⌂","Home"\]/ },
];

for (const control of DEFAULT_SELECTED_CONTROLS) {
  test(`the default-selected "${control.label}" control in ${control.file.replace("../app/", "")} still matches a real option`, () => {
    const source = read(control.file);
    assert.match(source, control.state, "the default state this control writes must still exist");
    assert.match(source, control.option, "the control must still be one of the rendered options for that state");
  });
}

test("the AI analytics Clear control resets exactly the filters that start empty", () => {
  const source = read("../app/team/ai/analytics/page.tsx");
  for (const setter of ["setChannel", "setFrom", "setTo"]) {
    assert.match(source, new RegExp(`${setter}\\(""\\)`), `${setter} must still reset to the empty default`);
  }
  assert.match(source, /const \[channel, setChannel\] = useState\(""\)/);
  assert.match(source, /onClick=\{\(\) => \{ setChannel\(""\); setFrom\(""\); setTo\(""\); \}\}/);
});

const VALIDATED_SUBMIT_CONTROLS = [
  { file: "../app/team/catalogue/page.tsx", label: "Add", handler: "create" },
  { file: "../app/team/marketing/page.tsx", label: "Create draft", handler: "create" },
  { file: "../app/team/provider-verification/page.tsx", label: "Check", handler: "checkApp" },
  { file: "../app/team/subscription-plans/page.tsx", label: "Add plan", handler: "create" },
];

for (const control of VALIDATED_SUBMIT_CONTROLS) {
  test(`the "${control.label}" submit control stays inside a form that guards its required fields`, () => {
    const source = read(control.file);
    assert.match(source, new RegExp(`onSubmit=\\{${control.handler}\\}`), "the submit handler must stay attached to the form");
    assert.match(source, /required/, "the form must keep constraint validation on its required fields");
    assert.match(source, new RegExp(`(?:>|")${control.label}(?:<|")`), "the control label must still exist");
    assert.match(source, /preventDefault\(\)/, "the handler must still take over submission rather than navigating");
  });
}

test("the shared Button component still forwards type and handlers to the real button", () => {
  const button = read("../app/components/ui/Button.tsx");
  assert.match(button, /\.\.\.rest/, "Button must spread type/onClick through, or every Button-based control is genuinely unwired");
  assert.match(button, /<button className=\{combined\} \{\.\.\.rest\}>/);
});
