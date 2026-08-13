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
