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

test("/account, /ops and /admin retired: no fabricated dashboards remain reachable", () => {
  for (const [route, target] of [["/account", "/mobile-app"], ["/ops", "/team"], ["/admin", "/team"]]) {
    const page = read(`app${route}/page.tsx`);
    assert.match(page, new RegExp(`redirect\\("${target}"\\)`), `${route} must redirect to ${target}`);
    assert.doesNotMatch(page, /^"use client"/m, `${route} must redirect server-side`);
  }
  // the fabricated figures are gone with their pages and panels
  const account = read("app/account/page.tsx"), ops = read("app/ops/page.tsx"), admin = read("app/admin/page.tsx");
  for (const gone of ["Ananya Rao", "4.8 ★", "₹6,594", "Member since 2022"]) assert.ok(!account.includes(gone), `/account must not keep '${gone}'`);
  for (const gone of ["₹31.82L", "₹24.18L", "₹18.42L", "94%"]) assert.ok(!ops.includes(gone), `/ops must not keep '${gone}'`);
  for (const gone of ["₹32,482", "4.9 ★", "50,000+"]) assert.ok(!admin.includes(gone), `/admin must not keep '${gone}'`);
  for (const panel of ["boarding-panel", "food-panel", "mobility-panel", "workforce-panel"]) {
    assert.ok(!fs.existsSync(`app/admin/${panel}.tsx`), `the fabricated ${panel} is removed`);
  }
  // the real customer account surface it points at still exists and is wired
  assert.match(read("app/mobile-app/customer-account-view.tsx"), /fetch\(/, "the real customer account view reads live data");
});

test("/control keeps its real panels, states gaps honestly and no longer carries invented counts", () => {
  const control = read("app/control/page.tsx");
  // real panels are still mounted
  for (const panel of ["MarketingControlPanel", "PricingControlPanel", "FinanceControlPanel", "AccessControlPanel", "BusinessIntelligencePanel"]) {
    assert.ok(control.includes(panel), `${panel} must stay mounted`);
  }
  // the approvals backlog is real; timing/throughput say they are not measured
  assert.match(control, /approvals\.pending/, "the pending tile reads a real backlog");
  assert.match(control, /fetch\("\/api\/team-overview"/);
  for (const invented of ['"9", "₹1.84L value"', '"2", "Oldest 3h 18m"', '"42", "Median 18 min"', '"128", "Within safe limits"']) {
    assert.ok(!control.includes(invented), `the fabricated approvals tile ${invented} must be gone`);
  }
  assert.match(control, /Not measured/, "unmeasured approval SLA is stated, not invented");
  // sidebar badge counts were literals that never moved
  assert.ok(!/\bcount: \d+/.test(control), "no hardcoded sidebar badge counts remain");
  // honest infrastructure reporting kept
  assert.match(control, /Not connected/);
});
