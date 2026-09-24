import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
installWorkersHooks("__V2_FOOD_SESSION_DB__");
const { loadV2CustomerAccount, loadV2CustomerSession } = await import("../lib/v2/customer-experience-client.ts");

const source = await readFile(new URL("../app/food/canonical-food-page.tsx", import.meta.url), "utf8");

test("V2 customer session and account clients execute the fresh-auth bootstrap sequence", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async url => {
    calls.push(String(url));
    if (url === "/api/identity-session") return Response.json({ data: { subjectType: "customer", subjectId: "C-FOOD", identitySource: "otp" } });
    if (url === "/api/customer-account") return Response.json({ data: { customerId: "C-FOOD", name: "Food UAT", primaryPhone: "9000000000", cityId: "blr", pets: [], addresses: [], bookings: [], loyaltyPoints: 0, referralCode: "UAT" } });
    throw new Error(`Unexpected request ${url}`);
  });
  const session = await loadV2CustomerSession();
  assert.equal(session?.subjectId, "C-FOOD");
  const account = await loadV2CustomerAccount();
  assert.equal(account.customerId, "C-FOOD");
  assert.deepEqual(calls, ["/api/identity-session", "/api/customer-account"]);
});

test("V2 session client returns null on an expired session instead of inventing identity", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "expired" }, { status: 401 }));
  assert.equal(await loadV2CustomerSession(), null);
});

test("V2 Food preflights session and blocks reserve UI after account bootstrap failure", () => {
  assert.match(source, /routeScope==="v2"/);
  assert.match(source, /loadV2CustomerSession\(\)/);
  assert.match(source, /return loadV2CustomerAccount\(\)/);
  assert.match(source, /return loadCustomerAccount\(\)/, "legacy /food keeps its existing account loader");
  assert.match(source, /const bootstrapBlocked=Boolean\(accountError\)/);
  assert.match(source, /disabled=\{bootstrapBlocked\|\|!quote\|\|quoteLoading\|\|Boolean\(quoteError\)\|\|orderLoading\|\|!customer\}/);
  assert.match(source, /quoteLoading\?"Refreshing canonical quote…":accountError\?"":quoteError\?/);
});
