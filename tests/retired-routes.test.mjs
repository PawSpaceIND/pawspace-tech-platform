import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// /groomer was a hardcoded prototype that a tester could still reach by typing the URL:
// its jobs, customers and earnings were literals, "Complete" only moved React state, and
// proof photos were counted in the browser but never uploaded. app/prelaunch/page.tsx had
// listed it as retired without anything enforcing that. These tests keep the retirement real,
// and keep the retired list honest about the modules that are NOT retired.
// ---------------------------------------------------------------------------
const read = (path) => fs.readFileSync(path, "utf8");

test("/groomer redirects to the real Partner App workspace instead of rendering a mock", () => {
  const page = read("app/groomer/page.tsx");
  assert.match(page, /import \{ redirect \} from "next\/navigation"/);
  assert.match(page, /redirect\("\/partner-app"\)/);
  assert.doesNotMatch(page, /^"use client"/m, "a redirect must happen on the server, before any mock renders");
  // the prototype's fabricated data is gone
  for (const fabricated of ["PS-2841", "Ananya Rao", "Bruno", "1899", "groom_arun"]) {
    assert.ok(!page.includes(fabricated), `the hardcoded '${fabricated}' must not survive the retirement`);
  }
  assert.ok(!fs.existsSync("app/groomer/groomer.module.css"), "the prototype's orphaned stylesheet is removed");
});

test("the retired-route list only claims routes that actually redirect", () => {
  const prelaunch = read("app/prelaunch/page.tsx");
  const block = prelaunch.match(/const retiredRoutes[\s\S]*?\n\];/);
  assert.ok(block, "retiredRoutes list not found");
  const listed = [...block[0].matchAll(/from:"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(listed, ["/groomer"], "only /groomer is genuinely retired");
  for (const route of listed) {
    const page = read(`app${route}/page.tsx`);
    assert.match(page, /redirect\(/, `${route} is listed as retired so it must actually redirect`);
  }
});

test("regression: /trainer and /crm are real integrated modules and must NOT be retired", () => {
  // /trainer runs the canonical training session lifecycle, evidence and earnings
  const trainer = read("app/trainer/page.tsx");
  assert.match(trainer, /loadTrainerSessions/, "trainer loads real sessions");
  assert.match(trainer, /trainingSessionAction/, "trainer performs real session actions");
  assert.match(trainer, /prepareTrainingEvidence/, "trainer uploads governed evidence");
  assert.match(trainer, /api\/training-provider-earnings/, "trainer reads real earnings");
  assert.doesNotMatch(trainer, /redirect\(/, "trainer must keep rendering its real workspace");
  // /crm reads the canonical CRM and revenue engines
  const crm = read("app/crm/page.tsx");
  assert.match(crm, /fetch\("\/api\/crm"/, "crm reads the real CRM API");
  assert.doesNotMatch(crm, /redirect\(/, "crm must keep rendering");
  assert.match(read("app/crm/revenue-engine-panel.tsx"), /fetch\("\/api\/revenue-crm"/, "the revenue engine panel reads the real API");
});

test("retiring the prototype did not delete its one real capability — delay recovery moved to the Partner App", () => {
  const partnerApp = read("app/partner-app/page.tsx");
  assert.match(partnerApp, /recordBookingOperation/, "the governed booking-operations call survives the retirement");
  for (const action of ["package_upgrade", "service_overrun", "running_late", "vehicle_issue", "rebook_requested"]) {
    assert.ok(partnerApp.includes(`"${action}"`), `${action} must still be reportable`);
  }
  for (const button of ["Package upgraded", "Service taking longer", "Running late", "Bike issue"]) {
    assert.ok(partnerApp.includes(button), `the '${button}' control must exist on the real surface`);
  }
  // and it now uses the REAL selected booking, not the prototype's hardcoded IDs
  assert.match(partnerApp, /bookingId: selected\.bookingId/, "the operation targets the real selected booking");
  assert.match(partnerApp, /providerId: selected\.providerId/, "the operation targets the real provider");
  assert.ok(!partnerApp.includes("PS-2841") && !partnerApp.includes('"groom_arun"'), "no hardcoded prototype IDs came across");
  assert.match(partnerApp, /impactMinutes: delayMinutes/, "the operator-chosen delay is sent");
});

test("the real groomer-facing surfaces stay wired to canonical APIs", () => {
  const partnerApp = read("app/partner-app/page.tsx");
  assert.match(partnerApp, /fetch\("\/api\/grooming-lifecycle"/, "the replacement workspace drives the canonical grooming lifecycle");
  assert.match(read("app/partner/jobs/page.tsx"), /fetch\("\/api\/partner-job-feed"/);
  assert.match(read("app/partner/workspace/page.tsx"), /fetch\("\/api\/provider-workspace"/);
});

// /admin is deliberately NOT in this list any more. This branch retired it as a fabricated
// dashboard, and while that was true when the sweep ran, main then made the /admin shell read
// /api/operations-overview (#154) and report in IST (#156). Retiring a page that another change had
// just made real would have deleted working code, so the retirement was dropped on merge and /admin
// is pinned as live below instead.
test("/account and /ops retired: no fabricated dashboards remain reachable", () => {
  for (const [route, target] of [["/account", "/mobile-app"], ["/ops", "/team"]]) {
    const page = read(`app${route}/page.tsx`);
    assert.match(page, new RegExp(`redirect\\("${target}"\\)`), `${route} must redirect to ${target}`);
    assert.doesNotMatch(page, /^"use client"/m, `${route} must redirect server-side`);
  }
  // the fabricated figures are gone with their pages and panels
  const account = read("app/account/page.tsx"), ops = read("app/ops/page.tsx");
  for (const gone of ["Ananya Rao", "4.8 ★", "₹6,594", "Member since 2022"]) assert.ok(!account.includes(gone), `/account must not keep '${gone}'`);
  for (const gone of ["₹31.82L", "₹24.18L", "₹18.42L", "94%"]) assert.ok(!ops.includes(gone), `/ops must not keep '${gone}'`);
  // the real customer account surface it points at still exists and is wired
  assert.match(read("app/mobile-app/customer-account-view.tsx"), /fetch\(/, "the real customer account view reads live data");
});

test("/admin is live and reads the database — it must not be retired by a stale sweep", () => {
  const admin = read("app/admin/page.tsx");
  assert.doesNotMatch(admin, /redirect\("\/team"\)/, "/admin reads /api/operations-overview; retiring it would delete working code");
  assert.match(admin, /fetch\(`?\/api\/operations-overview/, "the /admin shell reads a real endpoint");
  // The training panel it mounts is the one real panel in that shell, and /team/operations/training
  // mounts the SAME component rather than a copy of it.
  assert.match(read("app/admin/training-panel.tsx"), /\/api\/training-ops/, "the training panel reads a real endpoint");
  assert.match(read("app/team/operations/training/page.tsx"), /from "\.\.\/\.\.\/\.\.\/admin\/training-panel"/, "one implementation, two entry points");
  assert.ok(!fs.existsSync("app/team/operations/training/training-panel.tsx"), "the panel must not be duplicated");
});

// This branch made /control honest by reading a real approvals backlog from /api/team-overview.
// Main solved the same problem more thoroughly in #156: a purpose-built /api/control-tower, plus an
// on-screen label for every view still rendering example rows. Main's version was kept on merge, so
// this test pins MAIN's mechanism rather than the one this branch wrote.
test("/control measures instead of asserting, and labels the views that are still prototypes", () => {
  const control = read("app/control/page.tsx");
  for (const panel of ["MarketingControlPanel", "PricingControlPanel", "FinanceControlPanel", "AccessControlPanel", "BusinessIntelligencePanel"]) {
    assert.ok(control.includes(panel), `${panel} must stay mounted`);
  }
  assert.match(control, /fetch\("\/api\/control-tower"/, "the tower reads a real endpoint");
  assert.match(control, /PROTOTYPE_CONTROL_VIEWS/, "views still showing example rows must be labelled on screen");
  // main kept four invented approvals tiles behind that label; this branch's real backlog replaced
  // the one of them that has a source, and the other three now state that they are not measured.
  assert.match(control, /fetch\("\/api\/team-overview"/, "the pending tile reads a real backlog");
  assert.match(control, /approvals\.pending/);
  assert.match(control, /Not measured/, "unmeasured approval timing is stated, not invented");
  // the invented tiles and badge counts this branch also removed must stay gone
  for (const invented of ['"9", "₹1.84L value"', '"2", "Oldest 3h 18m"', '"42", "Median 18 min"', '"128", "Within safe limits"']) {
    assert.ok(!control.includes(invented), `the fabricated approvals tile ${invented} must be gone`);
  }
  assert.ok(!/\bcount: \d+/.test(control), "no hardcoded sidebar badge counts remain");
  assert.match(control, /Not connected/);
});
