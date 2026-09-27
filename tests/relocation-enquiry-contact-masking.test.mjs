/*
 * Round-2 staging (P3): /team/relocation-enquiries showed every enquirer's full phone number and email to
 * any customers.view role (a sales associate included) while the CRM showed the same people masked.
 * Executed against the real route with real actors.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, seedActors, asActor, ORIGIN } from "./helpers/execution-harness.mjs";

installWorkersHooks("__RELQ_MASK_DB__", "__RELQ_MASK_ENV__");
const route = await import("../app/api/relocation-enquiry/route.ts");

const ASSOCIATE = "relocation.associate@pawspace.test", MANAGER = "relocation.manager@pawspace.test", ADMIN = "relocation.admin@pawspace.test", PROVIDER = "relocation.provider@pawspace.test";
const enquiry = {
  customerName: "Mask Check", phonePrimary: "9876543210", phoneSecondary: "9876501234", email: "mask.check@example.test", petType: "dog",
  relocationKind: "international", pickupDate: "2026-12-01", pickupApproxTime: "10:00", pickupLocation: "Indiranagar, Bengaluru 560038",
  dropLocation: "Dubai Marina, Dubai", expectedTravelDate: "2026-12-03",
};

async function seeded() {
  const w = world("__RELQ_MASK_DB__", "__RELQ_MASK_ENV__");
  await seedActors(w.sqlite, w.db, [
    { id: "U-ASSOC", email: ASSOCIATE, role: "associate" }, { id: "U-MGR", email: MANAGER, role: "manager" },
    { id: "U-ADMIN", email: ADMIN, role: "admin" }, { id: "U-PROV", email: PROVIDER, role: "service_provider" },
  ]);
  const created = await route.POST(new Request(`${ORIGIN}/api/relocation-enquiry`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(enquiry) }));
  assert.equal(created.status, 200, await created.clone().text());
  return w;
}
const list = async (email) => { const response = await route.GET(asActor(email, "/api/relocation-enquiry")); return { status: response.status, body: await response.json() }; };

test("an associate and a manager see relocation enquirers' numbers and email masked, as the CRM shows them", async () => {
  await seeded();
  for (const email of [ASSOCIATE, MANAGER]) {
    const { status, body } = await list(email);
    assert.equal(status, 200, JSON.stringify(body));
    const [row] = body.data;
    assert.equal(row.phonePrimary, "+91 ••••••3210", email);
    assert.equal(row.phoneSecondary, "+91 ••••••1234", email);
    assert.equal(row.email, "•••@example.test", email);
    assert.equal(row.customerName, "Mask Check", "the enquiry stays recognisable");
    assert.equal(body.contactMasked, true);
    const raw = JSON.stringify(body);
    for (const secret of ["9876543210", "9876501234", "mask.check@"]) assert.ok(!raw.includes(secret), `${email} must not receive ${secret}`);
  }
});

test("a role holding customers.view_full_phone still sees the full contact; a role without customers.view is refused", async () => {
  await seeded();
  const admin = await list(ADMIN);
  assert.equal(admin.status, 200);
  assert.equal(admin.body.data[0].phonePrimary, "9876543210");
  assert.equal(admin.body.data[0].email, "mask.check@example.test");
  assert.equal(admin.body.contactMasked, false);
  assert.equal((await list(PROVIDER)).status, 403);
});
