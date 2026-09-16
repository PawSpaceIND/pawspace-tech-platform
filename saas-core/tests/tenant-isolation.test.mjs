/*
 * The adversarial cross-tenant battery.
 *
 * "Nothing else gets built ahead of tenant isolation." This file is what that sentence means in
 * practice. Each test takes the position of a hostile or buggy caller inside Tenant A trying to
 * reach Tenant B, and asserts the platform refuses.
 *
 * These are not unit tests of a function. They are the security property the whole product rests
 * on, and any one of them going red is a release blocker, not a flake to retry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, seedTenant, T0 } from "./helpers/harness.mjs";

async function twoTenants() {
  const { db, sqlite } = await world();
  const a = await seedTenant(db, { slug: "acme-salon", name: "Acme Salon", ownerEmail: "owner-a@example.com" });
  const b = await seedTenant(db, { slug: "beta-spa", name: "Beta Spa", vertical: "spa", ownerEmail: "owner-b@example.com" });
  return { db, sqlite, a, b };
}

test("ISO-01 a context cannot read another tenant's customer by id", async () => {
  const { a, b } = await twoTenants();
  const stolen = await a.ctx.first("customers", { id: b.customerId });
  assert.equal(stolen, null, "Tenant A resolved Tenant B's customer id");

  const own = await a.ctx.first("customers", { id: a.customerId });
  assert.ok(own, "Tenant A cannot see its own customer, so the test proves nothing");
});

test("ISO-02 a context cannot update another tenant's row", async () => {
  const { a, b } = await twoTenants();
  const changed = await a.ctx.update("customers", { display_name: "Hijacked" }, { id: b.customerId });
  assert.equal(changed, 0);

  const victim = await b.ctx.first("customers", { id: b.customerId });
  assert.equal(victim.display_name, "Anita", "Tenant B's row was modified from Tenant A");
});

test("ISO-03 a context cannot delete another tenant's row", async () => {
  const { a, b } = await twoTenants();
  const removed = await a.ctx.remove("customers", { id: b.customerId });
  assert.equal(removed, 0);
  assert.equal(await b.ctx.count("customers", { id: b.customerId }), 1);
});

test("ISO-04 a forged tenant_id in an insert payload is ignored, not honoured", async () => {
  const { a, b } = await twoTenants();
  await a.ctx.insert("customers", {
    id: "cus_forged",
    tenant_id: b.tenantId,
    display_name: "Planted",
    email: null,
    phone: null,
    created_at: T0,
  });

  assert.equal(await b.ctx.count("customers", { id: "cus_forged" }), 0, "row landed in Tenant B");
  assert.equal(await a.ctx.count("customers", { id: "cus_forged" }), 1, "row did not land in Tenant A");
});

test("ISO-05 identical ids in two tenants are two different rows", async () => {
  const { a, b } = await twoTenants();
  const shared = "cus_same_id";
  await a.ctx.insert("customers", { id: shared, display_name: "A's Anita", created_at: T0 });
  await b.ctx.insert("customers", { id: shared, display_name: "B's Anita", created_at: T0 });

  assert.equal((await a.ctx.first("customers", { id: shared })).display_name, "A's Anita");
  assert.equal((await b.ctx.first("customers", { id: shared })).display_name, "B's Anita");
});

test("ISO-06 opening a tenant without a membership is refused", async () => {
  const { db, a, b } = await twoTenants();
  const { TenantContext, TenantAccessError } = await import("../src/tenancy/context.ts");
  await assert.rejects(
    () => TenantContext.open(db, { identityId: a.ownerIdentityId, tenantId: b.tenantId, now: T0 }),
    TenantAccessError,
  );
});

test("ISO-07 a suspended tenant cannot be opened even by its owner", async () => {
  const { db, a } = await twoTenants();
  const { TenantContext, TenantAccessError } = await import("../src/tenancy/context.ts");
  await db.prepare("UPDATE tenants SET status = 'suspended' WHERE id = ?").bind(a.tenantId).run();
  await assert.rejects(
    () => TenantContext.open(db, { identityId: a.ownerIdentityId, tenantId: a.tenantId, now: T0 }),
    TenantAccessError,
  );
});

test("ISO-08 a revoked membership cannot be opened", async () => {
  const { db, a } = await twoTenants();
  const { TenantContext, TenantAccessError } = await import("../src/tenancy/context.ts");
  const { revokeMembership } = await import("../src/tenancy/provisioning.ts");
  await revokeMembership(db, a.tenantId, a.ownerIdentityId);
  await assert.rejects(
    () => TenantContext.open(db, { identityId: a.ownerIdentityId, tenantId: a.tenantId, now: T0 }),
    TenantAccessError,
  );
});

test("ISO-09 an expired trial cannot be opened", async () => {
  const { db, a } = await twoTenants();
  const { TenantContext, TenantAccessError } = await import("../src/tenancy/context.ts");
  const afterTrial = T0 + 8 * 86_400_000;
  await assert.rejects(
    () => TenantContext.open(db, { identityId: a.ownerIdentityId, tenantId: a.tenantId, now: afterTrial }),
    TenantAccessError,
  );
});

test("ISO-10 a branch-scoped member cannot read another branch in the same tenant", async () => {
  const { db, a } = await twoTenants();
  const { TenantContext } = await import("../src/tenancy/context.ts");
  const { createLocation, resolveIdentity, grantMembership } = await import("../src/tenancy/provisioning.ts");
  const { addStaff } = await import("../src/domain/catalogue.ts");

  const second = await createLocation(a.ctx, {
    brandId: a.brandId, name: "Acme Second", timezone: "Asia/Kolkata", currency: "INR", now: T0,
  });
  const otherBranchStaff = await addStaff(a.ctx, { locationId: second, displayName: "Ravi", now: T0 });

  const managerId = await resolveIdentity(db, { email: "branch-manager@example.com", displayName: "Branch Manager", now: T0 });
  await grantMembership(db, {
    tenantId: a.tenantId, identityId: managerId, role: "manager", locationScope: [a.locationId], now: T0,
  });
  const scoped = await TenantContext.open(db, { identityId: managerId, tenantId: a.tenantId, now: T0 });

  assert.equal(await scoped.first("staff", { id: otherBranchStaff }), null, "branch-scoped manager read another branch");
  assert.ok(await scoped.first("staff", { id: a.staffId }), "branch-scoped manager cannot read their own branch");
});

test("ISO-11 a branch-scoped member cannot write into a branch outside their scope", async () => {
  const { db, a } = await twoTenants();
  const { TenantContext, TenantAccessError } = await import("../src/tenancy/context.ts");
  const { createLocation, resolveIdentity, grantMembership } = await import("../src/tenancy/provisioning.ts");
  const { addStaff } = await import("../src/domain/catalogue.ts");

  const second = await createLocation(a.ctx, {
    brandId: a.brandId, name: "Acme Second", timezone: "Asia/Kolkata", currency: "INR", now: T0,
  });
  const managerId = await resolveIdentity(db, { email: "bm2@example.com", displayName: "BM2", now: T0 });
  await grantMembership(db, {
    tenantId: a.tenantId, identityId: managerId, role: "manager", locationScope: [a.locationId], now: T0,
  });
  const scoped = await TenantContext.open(db, { identityId: managerId, tenantId: a.tenantId, now: T0 });

  await assert.rejects(
    () => addStaff(scoped, { locationId: second, displayName: "Planted", now: T0 }),
    TenantAccessError,
  );
});

test("ISO-12 an empty location scope sees nothing, never everything", async () => {
  const { db, a } = await twoTenants();
  const { TenantContext } = await import("../src/tenancy/context.ts");
  const { resolveIdentity, grantMembership } = await import("../src/tenancy/provisioning.ts");

  const id = await resolveIdentity(db, { email: "nobody@example.com", displayName: "Nobody", now: T0 });
  await grantMembership(db, { tenantId: a.tenantId, identityId: id, role: "manager", locationScope: [], now: T0 });
  const scoped = await TenantContext.open(db, { identityId: id, tenantId: a.tenantId, now: T0 });

  assert.equal(await scoped.count("staff"), 0);
  assert.equal(await scoped.count("locations"), 0);
  // Tables without a location column stay tenant-visible: an empty branch scope is not a tenant ban.
  assert.ok((await scoped.count("services")) >= 1);
});

test("ISO-13 one person in two tenants gets two contexts with no bleed", async () => {
  const { db, a, b } = await twoTenants();
  const { TenantContext } = await import("../src/tenancy/context.ts");
  const { resolveIdentity, grantMembership } = await import("../src/tenancy/provisioning.ts");

  // The same stylist, one login, working weekends at both businesses.
  const stylist = await resolveIdentity(db, { email: "stylist@example.com", displayName: "Sam", now: T0 });
  await grantMembership(db, { tenantId: a.tenantId, identityId: stylist, role: "front_desk", now: T0 });
  await grantMembership(db, { tenantId: b.tenantId, identityId: stylist, role: "staff", now: T0 });

  const inA = await TenantContext.open(db, { identityId: stylist, tenantId: a.tenantId, now: T0 });
  const inB = await TenantContext.open(db, { identityId: stylist, tenantId: b.tenantId, now: T0 });

  assert.equal(inA.role, "front_desk");
  assert.equal(inB.role, "staff");
  assert.equal(await inA.first("customers", { id: b.customerId }), null);
  assert.equal(await inB.first("customers", { id: a.customerId }), null);
  // Role is per membership: front_desk can manage customers, staff cannot.
  assert.equal(inA.can("customers.manage"), true);
  assert.equal(inB.can("customers.manage"), false);
});

test("ISO-14 the same email may be a customer of two tenants, invisibly to both", async () => {
  const { a, b } = await twoTenants();
  const { createCustomer } = await import("../src/domain/booking.ts");

  // Both seeds already created anita@example.com. Neither may learn about the other.
  const inA = await a.ctx.all("customers", { email: "anita@example.com" });
  const inB = await b.ctx.all("customers", { email: "anita@example.com" });
  assert.equal(inA.length, 1);
  assert.equal(inB.length, 1);
  assert.notEqual(inA[0].id, inB[0].id);

  // And the per-tenant unique index still bites within a tenant.
  await assert.rejects(() => createCustomer(a.ctx, { displayName: "Duplicate", email: "anita@example.com", now: T0 }));
});

test("ISO-15 the audit log is tenant-scoped", async () => {
  const { a, b } = await twoTenants();
  await a.ctx.audit({ action: "test.marker", entity: "test", entityId: "marker-a" });

  const seenByB = await b.ctx.all("audit_log", { entity_id: "marker-a" });
  assert.equal(seenByB.length, 0, "Tenant B read Tenant A's audit trail");
  assert.equal((await a.ctx.all("audit_log", { entity_id: "marker-a" })).length, 1);
});

test("ISO-16 rawTenantQuery refuses SQL with no tenant predicate", async () => {
  const { a } = await twoTenants();
  const { TenantAccessError } = await import("../src/tenancy/context.ts");

  await assert.rejects(
    () => a.ctx.rawTenantQuery("SELECT id FROM customers WHERE display_name = ?", ["Anita"], "no predicate"),
    TenantAccessError,
  );
  await assert.rejects(
    () => a.ctx.rawTenantQuery("SELECT id FROM customers WHERE tenant_id = ?", [], "short"),
    TenantAccessError,
    "a reason shorter than 8 characters was accepted",
  );
});

test("ISO-17 rawTenantQuery binds the context's tenant, not a caller-supplied one", async () => {
  const { a, b } = await twoTenants();
  // The caller writes the predicate but does NOT get to fill it: tenant_id is bound first, from the
  // context. Passing Tenant B's id as an argument shifts it onto the display_name placeholder.
  const rows = await a.ctx.rawTenantQuery(
    "SELECT id FROM customers WHERE tenant_id = ? AND display_name = ?",
    [b.tenantId],
    "attempt to redirect the tenant predicate",
  );
  assert.equal(rows.length, 0);
});

test("ISO-18 identifier injection through a where-key or table name is refused", async () => {
  const { a } = await twoTenants();
  const { TenantAccessError } = await import("../src/tenancy/context.ts");

  await assert.rejects(() => a.ctx.all("customers", { "id = 'x' OR 1=1 --": "y" }), TenantAccessError);
  await assert.rejects(() => a.ctx.all("customers; DROP TABLE customers", {}), TenantAccessError);
  await assert.rejects(() => a.ctx.all("customers", { tenant_id: "anything" }), TenantAccessError);
  await assert.rejects(() => a.ctx.update("customers", { tenant_id: "elsewhere" }, { id: a.customerId }), TenantAccessError);
});

test("ISO-19 unregistered and platform tables are unreachable through a context", async () => {
  const { a } = await twoTenants();
  const { TenantAccessError } = await import("../src/tenancy/context.ts");

  // `tenants` and `identities` define the platform; reading them through a tenant context would be
  // reading every customer of every business.
  await assert.rejects(() => a.ctx.all("tenants"), TenantAccessError);
  await assert.rejects(() => a.ctx.all("identities"), TenantAccessError);
  // The membership bridge is resolved before a context exists and must not be reachable from one.
  await assert.rejects(() => a.ctx.all("memberships"), TenantAccessError);
  // A table nobody classified is refused rather than assumed safe.
  await assert.rejects(() => a.ctx.all("some_future_table"), TenantAccessError);
});

test("ISO-20 booking cannot reference another tenant's customer, service, staff or resource", async () => {
  const { a, b } = await twoTenants();
  const { bookAppointment } = await import("../src/domain/booking.ts");
  const at = T0 + 3_600_000;

  const base = { locationId: a.locationId, customerId: a.customerId, serviceId: a.serviceId, staffId: a.staffId, resourceId: a.chairId, startsAt: at, now: T0 };

  await assert.rejects(() => bookAppointment(a.ctx, { ...base, customerId: b.customerId }), /Customer not found/);
  await assert.rejects(() => bookAppointment(a.ctx, { ...base, serviceId: b.serviceId }), /Service not found/);
  await assert.rejects(() => bookAppointment(a.ctx, { ...base, staffId: b.staffId }), /Staff member not found/);
  await assert.rejects(() => bookAppointment(a.ctx, { ...base, resourceId: b.chairId }), /Resource not found/);

  // And the same call with all of Tenant A's own ids succeeds, so the rejections above are about
  // the tenant boundary and not about a broken booking path.
  assert.ok(await bookAppointment(a.ctx, base));
});
