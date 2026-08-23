import test from "node:test";
import assert from "node:assert/strict";
import { setupJourney, routeCall, sessionCookie } from "./helpers/grooming-journey-harness.mjs";

function tableCount(sqlite, table) {
  const exists = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!exists) return 0;
  return Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
}

test("reserve rejects a cross-customer customerId before creating scheduling state", async (t) => {
  const ctx = await setupJourney();
  t.after(ctx.close);

  const authenticatedCustomerId = "CUST-OWNERSHIP-A";
  const forgedCustomerId = "CUST-OWNERSHIP-B";
  const cookie = await sessionCookie(ctx.db, "customer", authenticatedCustomerId, `customer:${authenticatedCustomerId}`);
  const startDate = new Date(Date.now() + 8 * 86_400_000);
  startDate.setUTCHours(5, 30, 0, 0);
  const scheduledStart = startDate.toISOString();
  const scheduledEnd = new Date(startDate.getTime() + 2 * 60 * 60_000).toISOString();

  const beforeReservations = tableCount(ctx.sqlite, "scheduling_reservations");
  const beforeDecisions = tableCount(ctx.sqlite, "scheduling_assignment_decisions");

  const rejected = await routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", {
    clientRequestId: "OWNERSHIP-CROSS-CUSTOMER",
    customerId: forgedCustomerId,
    petIds: ["PET-OWNERSHIP"],
    serviceCode: "grooming",
    cityId: "blr",
    zoneId: "blr-east",
    scheduledStart,
    scheduledEnd,
    preferredProviderId: "groom_arun",
  }, cookie);

  assert.equal(rejected.status, 403, JSON.stringify(rejected.body));
  assert.match(String(rejected.body?.error ?? ""), /ownership denied/i);
  assert.equal(tableCount(ctx.sqlite, "scheduling_reservations"), beforeReservations, "cross-customer reserve must create zero reservation rows");
  assert.equal(tableCount(ctx.sqlite, "scheduling_assignment_decisions"), beforeDecisions, "cross-customer reserve must create zero decision rows");
});
