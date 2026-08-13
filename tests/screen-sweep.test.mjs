import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { discoverRoutes, verdict, EMPTY_STATE_PHRASES, EXPECTED_WITHOUT_SESSION, FAIL_LEVELS, UNTESTED_LEVELS } from "../scripts/screen-sweep.mjs";

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

test("a deep-link page that asks for its parameter is passing", () => {
  // /walking/manage, /driver/proof, /walker/proof and /sitter all do this, in four different wordings.
  // The first version of the sweep reported all four as BLANK.
  const wordings = ["Open with canonical bookingId.", "Open this page with a canonical booking ID.", "Open this workspace from a confirmed Sitting booking", "Open with canonical orderId."];
  for (const wording of wordings) {
    const matched = EMPTY_STATE_PHRASES.filter((phrase) => wording.toLowerCase().includes(phrase));
    assert.ok(matched.length > 0, `"${wording}" must be recognised as an instruction, not an empty screen`);
  }
});

test("an unresolved identity that explains itself is passing", () => {
  const said = "No provider record linked. Your identity is signed in but not yet linked to a provider";
  const matched = EMPTY_STATE_PHRASES.filter((phrase) => said.toLowerCase().includes(phrase));
  assert.ok(matched.length > 0, "/partner/workspace explains itself correctly and must not be reported");
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
  assert.ok(EXPECTED_WITHOUT_SESSION.length >= 3);
  assert.ok(EMPTY_STATE_PHRASES.length >= 25, "the empty-state vocabulary must cover the wordings actually in use");
});
