import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const queryConsumers = [
  ["app/driver/canonical-driver-page.tsx", "bookingId"],
  ["app/driver/recovery/page.tsx", "bookingId"],
  ["app/driver/proof/page.tsx", "bookingId"],
  ["app/food/subscription-invoice/page.tsx", "invoiceId"],
  ["app/food/subscription-payment/page.tsx", "renewalId"],
  ["app/food/subscriptions/page.tsx", "subscriptionId"],
  ["app/food/subscriptions/page.tsx", "sourceOrderId"],
  ["app/host/proof/page.tsx", "stayId"],
  ["app/sitter/proof/page.tsx", "bookingId"],
  ["app/team/operations/food/fulfilment/page.tsx", "orderId"],
  ["app/team/operations/food/proof/page.tsx", "orderId"],
  ["app/walker/page.tsx", "bookingId"],
  ["app/walker/proof/page.tsx", "bookingId"],
  ["app/walker/proof/page.tsx", "sessionId"],
  ["app/walker/recovery/page.tsx", "bookingId"],
];

test("migrated workspaces read every query parameter through the shared hook", () => {
  for (const [file, parameter] of queryConsumers) {
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, new RegExp(`useQueryParameter\\(\\"${parameter}\\"\\)`), `${file}:${parameter}`);
    assert.doesNotMatch(source, /useState\(\(\)=>typeof window/, file);
  }
});

test("shared query hook is hydration-safe and reacts to client-side URL changes", () => {
  const source = fs.readFileSync("lib/use-query-parameter.ts", "utf8");
  assert.match(source, /useSyncExternalStore/);
  assert.match(source, /\(\) => ""/);
  assert.match(source, /window\.location\.search/);
  assert.match(source, /popstate/);
  assert.match(source, /history\.pushState/);
  assert.match(source, /history\.replaceState/);
  assert.match(source, /pawspace:urlchange/);
});

test("client pages do not read query parameters during the hydration render", () => {
  const pages = fs.readdirSync("app", { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".tsx"));
  for (const file of pages) {
    const source = fs.readFileSync(`app/${file}`, "utf8");
    assert.doesNotMatch(source, /new URLSearchParams\(window\.location\.search\)/, file);
  }
});
