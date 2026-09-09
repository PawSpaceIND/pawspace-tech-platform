import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repoRoot = new URL("../", import.meta.url);

const read = async (path) => readFile(new URL(path, repoRoot), "utf8");

test("PR357 convergence: premium shell assets remain wired through the mobile-app layout", async () => {
  const layout = await read("app/mobile-app/layout.tsx");
  for (const asset of ["premium-shell-v2.css", "premium-flow-polish.css", "premium-shell-fix.css"]) {
    assert.match(layout, new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${asset} must remain imported by the mobile app layout`);
  }
});

test("PR357 convergence: modern discovery home keeps current data surfaces and all service affordances", async () => {
  const home = await read("app/mobile-app/premium-discovery-home.tsx");
  assert.match(home, /\/api\/customer-account\?customerId=/, "customer account data must remain connected");
  assert.match(home, /\/api\/customer-offers\?customerId=/, "customer offers must remain connected");
  assert.match(home, /Upcoming booking|UPCOMING BOOKING/, "current upcoming-booking surface must remain present");
  assert.match(home, /CAMPAIGNS/, "current campaign surface must remain present");
  assert.match(home, /VIDEO_SERVICE_CODES/, "six-service guide contract must remain present");
  for (const code of ["grooming", "dog_training", "boarding", "pet_sitting", "dog_walking", "pet_taxi", "food", "relocation"]) {
    assert.match(home, new RegExp(`(?:${code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`), `${code} must remain represented in the discovery contract`);
  }
});

test("PR357 convergence: premium visual system remains additive and presentation-only", async () => {
  const [flowCss, shellCss, fixCss] = await Promise.all([
    read("app/mobile-app/premium-flow-polish.css"),
    read("app/mobile-app/premium-shell-v2.css"),
    read("app/mobile-app/premium-shell-fix.css"),
  ]);
  assert.match(flowCss, /Presentation only: no data flow, API, booking, pricing, availability or business logic/);
  assert.match(shellCss, /No behaviour, data, API or booking logic/);
  assert.match(fixCss, /No data, API, booking, pricing or business behaviour changes/);
  assert.match(flowCss, /--pv2-forest:/, "premium theme tokens from PR357 must remain available");
  assert.match(shellCss, /grooming-flow_flow/, "grooming visual convergence rules must remain available");
  assert.match(fixCss, /main\[data-theme\]>section:has\(\[data-discovery\]\)/, "home-specific shell correction must remain present");
});

test("PR357 convergence: acceptance harness targets modern home and preserves six-guide/8-service coverage", async () => {
  const harness = await read("scripts/customer-ui-acceptance-v2.mjs");
  assert.match(harness, /Everything they need/);
  assert.match(harness, /Quick service guides/);
  assert.match(harness, /guide slots=.*expected 6/);
  for (const label of ["Grooming", "Training", "Boarding", "Pet Sitting", "Pet Taxi", "Dog Walking", "Fresh Food", "Relocation"]) {
    assert.match(harness, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
