import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("embedded walking and taxi resolve a six-digit service PIN before scheduling", () => {
  for (const path of ["app/mobile-app/walking-flow.tsx", "app/mobile-app/taxi-flow.tsx"]) {
    const source = read(path);
    assert.match(source, /resolveServiceCoverage\(pincode\)/, path);
    assert.match(source, /pincode\.length !== 6/, path);
    assert.doesNotMatch(source, /zoneId:\s*"blr-east"/, path);
    assert.doesNotMatch(source, /cityId:\s*"blr"/, path);
  }
});

test("standalone Walking and Taxi also fail closed through the governed service PIN", () => {
  for (const path of ["app/walking/page.tsx", "app/taxi/canonical-taxi-page.tsx"]) {
    const source = read(path);
    assert.match(source, /resolveServiceCoverage\(pincode\)/, path);
    assert.match(source, /Service PIN/, path);
    assert.doesNotMatch(source, /zoneId:\s*"blr-east"/, path);
    assert.doesNotMatch(source, /cityId:\s*"blr"/, path);
  }
});

test("embedded training uses resolved coverage and never marks an unverified payment captured", () => {
  const source = read("app/mobile-app/training-flow.tsx");
  assert.match(source, /resolveServiceCoverage\(pincode\)/);
  assert.match(source, /zoneId:serviceCoverage\.zoneId/);
  assert.match(source, /status:"created"/);
  assert.doesNotMatch(source, /status:"captured"/);
  assert.doesNotMatch(source, /zoneId:"blr-east"/);
});

test("food catalogue and quote use PIN-resolved coverage without live inventory claims", () => {
  const source = read("app/mobile-app/food-flow.tsx");
  assert.match(source, /loadFoodCatalogue\(resolved\.zoneId\)/);
  assert.match(source, /quoteFoodCart\(petBoundCart, resolved\.zoneId, customer\.customerId\)/);
  assert.match(source, /stock is a test allocation, not live warehouse inventory/i);
  assert.doesNotMatch(source, /Loading the live catalogue/);
  assert.doesNotMatch(source, /zoneId:\s*"blr-east"/);
});

test("customer Activity renders canonical account bookings instead of dated demo cards", () => {
  const source = read("app/mobile-app/page.tsx");
  assert.match(source, /Loading your canonical activity/);
  assert.match(source, /setBookings\(body\.data\?\.bookings\?\?\[\]\)/);
  assert.doesNotMatch(source, /Bruno · 6 Aug/);
  assert.doesNotMatch(source, /Coco · 30 Aug/);
});

test("service cards do not advertise live GPS or tracking that UAT has not activated", () => {
  const shell = read("app/mobile-app/page.tsx");
  const walking = read("app/mobile-app/walking-flow.tsx");
  const tracking = read("app/mobile-app/provider-tracking-card.tsx");
  const stay = read("app/mobile-app/stay-flow.tsx");
  assert.doesNotMatch(shell, /GPS walks/);
  assert.doesNotMatch(shell, /Tracked pickup/);
  assert.doesNotMatch(walking, /GPS-tracked/);
  assert.match(tracking, /LOCATION SHARING · NOT CONNECTED IN UAT/);
  assert.match(tracking, /No location is collected or displayed/);
  assert.doesNotMatch(tracking, /route refreshed just now/);
  assert.doesNotMatch(stay, /KA 03 EV 4821/);
});
