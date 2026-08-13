import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { discoverRoutes, verdict, detectEmptyStates, EXPECTED_WITHOUT_SESSION, FAIL_LEVELS, UNTESTED_LEVELS } from "../scripts/screen-sweep.mjs";

// ---------------------------------------------------------------------------
// scripts/screen-sweep.mjs opens every route in a real browser and reports which screens a tester can
// actually use. These tests pin its JUDGEMENT, which is the part that decides whether the tool is
// worth running.
//
// The history matters. The first version reported 40 of 130 routes as problems. Most were correct
// behaviour it did not recognise: a deep-link page saying "Open with canonical bookingId", a partner
// page saying "not yet linked to a provider", an /api/identity-session 401 on a signed-out customer
// screen. After calibration the same run reports 5. A sweep that cries wolf gets ignored, and being
// ignored is exactly how blank screens ended up being found by hand instead.
//
// So the property under test is not "does it find things" — it is "does it stay quiet about screens
// that are working". Both halves are asserted below.
// ---------------------------------------------------------------------------
const base = { route: "/x", status: 200, landed: "/x", redirected: false, failure: "", apiFailures: [], consoleErrors: [], pageErrors: [], textLength: 900, interactive: 20, formControls: 3, headings: 2, emptyStates: [] };
const at = (overrides) => verdict({ ...base, ...overrides });

test("a page rendering real content passes", () => {
  assert.equal(at({}).level, "OK");
});

test("the blank screen this sweep exists to catch is caught", () => {
  // A header and nothing else, no input, no explanation — the /team/ai/analytics defect exactly.
  assert.equal(at({ textLength: 90, interactive: 1, formControls: 0 }).level, "BLANK");
  assert.equal(at({ textLength: 200, formControls: 0 }).level, "THIN");
});

test("a screen that SAYS it is empty is passing, not failing", () => {
  // This is the distinction the whole tool turns on. "No data yet", rendered deliberately, is healthy.
  for (const phrase of ["nothing recorded", "no versions configured", "not measured"]) {
    assert.equal(at({ textLength: 150, formControls: 0, emptyStates: [phrase] }).level, "OK", `'${phrase}' is an honest empty state`);
  }
});

// The detector was a curated phrase list and it was wrong THREE TIMES, each time reporting a
// correctly-behaving page as broken: it missed "Open with canonical bookingId", then "not yet linked
// to a provider", then "No enquiries submitted yet". Enumerating wordings is unwinnable. It now
// matches the structure — a sentence OPENING with a negation or an instruction — and every wording
// that previously slipped through is pinned here so the list-shaped mistake cannot come back.
test("every real empty-state wording in this codebase is recognised", () => {
  const real = [
    "Pet Taxi proof\nOpen with canonical bookingId.\nDriver workspace",
    "Manage Dog Walking\nOpen this page with a canonical booking ID.",
    "PawSpace Sitting workspace\nOpen this workspace from a confirmed Sitting booking",
    "No provider record linked\nYour identity is signed in but not yet linked to a provider",
    "Submitted relocation enquiries\nNo enquiries submitted yet.",
    "Nothing recorded in this window.",
    "No versions configured.",
    "Assistant profiles\nNot measured",
    "Select a thread.",
  ];
  for (const text of real) {
    assert.ok(detectEmptyStates(text).length > 0, `this page explains itself and must pass: ${JSON.stringify(text.slice(0, 60))}`);
  }
});

test("a page that renders a title and nothing else is still a finding", () => {
  // The three food screens fixed alongside this test. If someone removes those empty states, the
  // sweep must go back to flagging them.
  for (const text of ["Manage Food order\nBack to Food", "PAWSPACE FOOD · RENEWAL INVOICE\nInvoice", "FOOD RENEWAL PAYMENT REQUEST · UAT\nPayment request"]) {
    assert.equal(detectEmptyStates(text).length, 0, `this says nothing about why it is empty: ${JSON.stringify(text)}`);
  }
});

test("detection is sentence-initial, so ordinary prose is not mistaken for an empty state", () => {
  // A bare /not/ anywhere in the text would match almost any page on this platform, which writes
  // "must not", "does not" and "cannot" constantly. That would silence the sweep entirely.
  const prose = "Revenue truth\nAchieved counts only what the payment records prove, and cancelled bookings are not revenue.";
  assert.equal(detectEmptyStates(prose).length, 0, "prose containing 'not' mid-sentence is not an empty state");
  // And the flattening bug: joining lines before detection destroyed the boundaries that make it work.
  assert.equal(detectEmptyStates("Pet Taxi proof Open with canonical bookingId.").length, 0, "flattened text genuinely has no sentence-initial instruction — which is why the sweep must pass raw innerText");
  assert.ok(detectEmptyStates("Pet Taxi proof\nOpen with canonical bookingId.").length > 0, "raw innerText keeps the boundary and detects it");
});

test("a form control counts as a way forward, links alone do not", () => {
  // /team/finance/food looks sparse but carries a "Load" field, so a tester can proceed.
  assert.equal(at({ textLength: 80, interactive: 5, formControls: 2 }).level, "OK");
  // Pure navigation is not a way forward — many links, nothing to do.
  assert.equal(at({ textLength: 80, interactive: 30, formControls: 0 }).level, "BLANK");
});

test("an API failure the platform makes BY DESIGN is reported as untested, not broken", () => {
  // A signed-out visitor gets 401 from identity-session; the scope-required feeds 400 asking for a
  // filter. Both are correct. Scoring them as failures buries the real findings.
  const gated = at({ apiFailures: ["401 /api/identity-session"] });
  assert.equal(gated.level, "GATED");
  assert.ok(UNTESTED_LEVELS.has(gated.level), "and it must be reported as NOT TESTED, never as a pass");
  assert.ok(!FAIL_LEVELS.has(gated.level));
  assert.match(gated.why, /--cookie/, "it must say how to actually cover the screen");

  assert.equal(at({ apiFailures: ["400 /api/partner-job-feed"] }).level, "GATED");
});

test("an API failure that is NOT by design is a real finding", () => {
  assert.equal(at({ apiFailures: ["500 /api/team-overview"] }).level, "DATA");
  // A 500 from an endpoint that has an expected-400 rule is still a 500.
  assert.equal(at({ apiFailures: ["500 /api/partner-job-feed"] }).level, "DATA");
  // An unexpected status on an expected-auth endpoint is still real.
  assert.equal(at({ apiFailures: ["403 /api/identity-session"] }).level, "DATA");
});

test("hard failures outrank everything, so a broken page is never scored on its text", () => {
  assert.equal(at({ status: 500 }).level, "BROKEN");
  assert.equal(at({ pageErrors: ["ReferenceError: x is not defined"] }).level, "BROKEN");
  assert.equal(at({ status: 0, failure: "page.goto: timeout" }).level, "BROKEN");
  // A white screen with a healthy-looking empty state must still report BROKEN.
  assert.equal(at({ status: 500, emptyStates: ["no data"], textLength: 900 }).level, "BROKEN");
});

test("route discovery covers the whole app and resolves dynamic segments", () => {
  const routes = discoverRoutes();
  assert.ok(routes.length > 100, `expected the full app, got ${routes.length} routes`);
  assert.ok(routes.includes("/"), "the customer root must be swept");
  assert.ok(routes.includes("/team"), "the staff front door must be swept");
  assert.ok(routes.includes("/team/ai/analytics"), "the page that started this must be swept");
  assert.ok(!routes.some((route) => /\[|\]/.test(route)), "no unresolved dynamic segment may reach the browser");
  // Discovery reads the filesystem, so a page added tomorrow is swept without touching this list.
  const onDisk = Number(fs.readdirSync("app", { recursive: true }).filter((entry) => String(entry).endsWith("page.tsx")).length);
  assert.ok(routes.length >= onDisk - 5, `discovery (${routes.length}) should track the pages on disk (${onDisk})`);
});

test("the sweep reports honestly about its own coverage", () => {
  const source = fs.readFileSync(new URL("../scripts/screen-sweep.mjs", import.meta.url), "utf8");
  assert.match(source, /NOT TESTED/, "routes it could not reach must be listed separately from passes");
  assert.match(source, /excerpt: measured\.text\.slice/, "each finding must carry what the page actually said, or triage needs a manual visit");
  assert.match(source, /networkidle/, "it must wait for client fetches — that is the whole point over curl");
  assert.match(source, /measured\.raw/, "detection must run on raw innerText — flattening destroys the sentence boundaries it relies on");
  assert.ok(EXPECTED_WITHOUT_SESSION.length >= 3);
});
