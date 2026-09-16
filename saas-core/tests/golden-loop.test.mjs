/*
 * The first engineering milestone, end to end:
 *
 *   tenant → brand → branch → staff + resources + services → customer → appointment
 *
 * Plus the claim the whole product rests on: ONE engine serves every vertical. A salon booking a
 * stylist to a chair, a spa booking a therapist to a room, a groomer booking a table and a clinic
 * booking an operatory are the same four rows with different labels. If that is not true, this is
 * six products wearing a trench coat and the plan does not work.
 *
 * Payment, invoice, commission, CRM and the AI tool layer are NOT here. They are Phase C onward and
 * this file will grow to meet them; it is not claiming a loop it does not close.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, seedTenant, T0 } from "./helpers/harness.mjs";

const MIN = 60_000;

test("LOOP-01 signup to booked appointment in one pass", async () => {
  const { db } = await world();
  const { provisionTenant, createBrand, createLocation } = await import("../src/tenancy/provisioning.ts");
  const { TenantContext } = await import("../src/tenancy/context.ts");
  const { addStaff, addResource, addService, qualifyStaff, qualifiedStaffIds } = await import("../src/domain/catalogue.ts");
  const { createCustomer, bookAppointment } = await import("../src/domain/booking.ts");

  const tenant = await provisionTenant(db, {
    slug: "glow-studio",
    name: "Glow Studio",
    vertical: "salon",
    owner: { email: "asha@glowstudio.in", displayName: "Asha" },
    now: T0,
  });
  const ctx = await TenantContext.open(db, { identityId: tenant.ownerIdentityId, tenantId: tenant.tenantId, now: T0 });
  assert.equal(ctx.role, "owner");

  const brandId = await createBrand(ctx, "Glow", T0);
  const locationId = await createLocation(ctx, { brandId, name: "Indiranagar", timezone: "Asia/Kolkata", currency: "INR", now: T0 });
  const staffId = await addStaff(ctx, { locationId, displayName: "Priya", now: T0 });
  const chairId = await addResource(ctx, { locationId, kind: "chair", name: "Chair 1", now: T0 });
  const serviceId = await addService(ctx, {
    name: "Cut & Finish", durationMinutes: 45, priceMinor: 90000, currency: "INR", resourceKind: "chair", bufferAfterMinutes: 15, now: T0,
  });
  await qualifyStaff(ctx, serviceId, staffId);
  assert.deepEqual(await qualifiedStaffIds(ctx, serviceId), [staffId]);

  const customerId = await createCustomer(ctx, { displayName: "Meera", phone: "+919000000001", now: T0 });
  const appointmentId = await bookAppointment(ctx, {
    locationId, customerId, serviceId, staffId, resourceId: chairId, startsAt: T0 + 60 * MIN, now: T0,
  });

  const booked = await ctx.first("appointments", { id: appointmentId });
  assert.equal(booked.status, "booked");
  assert.equal(booked.starts_at, T0 + 60 * MIN);
  assert.equal(booked.ends_at, T0 + 105 * MIN, "ends_at must be start + duration, excluding the buffer");
  assert.equal(booked.location_id, locationId);
});

test("LOOP-02 a new tenant starts on a seven-day trial", async () => {
  const { db } = await world();
  const a = await seedTenant(db, { slug: "trial-co", name: "Trial Co", ownerEmail: "t@example.com" });
  assert.equal(a.trialEndsAt, T0 + 7 * 86_400_000);
  const row = await db.prepare("SELECT status FROM tenants WHERE id = ?").bind(a.tenantId).first();
  assert.equal(row.status, "trialing");
});

test("LOOP-03 one owner, two businesses, one login", async () => {
  const { db } = await world();
  const { tenantsForIdentity } = await import("../src/tenancy/provisioning.ts");

  const first = await seedTenant(db, { slug: "shine-one", name: "Shine One", ownerEmail: "raj@example.com" });
  const second = await seedTenant(db, { slug: "shine-two", name: "Shine Two", vertical: "spa", ownerEmail: "raj@example.com" });

  assert.equal(first.ownerIdentityId, second.ownerIdentityId, "the same email produced two logins");
  const switcher = await tenantsForIdentity(db, first.ownerIdentityId);
  assert.deepEqual(switcher.map((t) => t.name), ["Shine One", "Shine Two"]);
  assert.ok(switcher.every((t) => t.role === "owner"));
});

test("LOOP-04 a buffer occupies the resource, so back-to-back inside it is refused", async () => {
  const { db } = await world();
  const a = await seedTenant(db, { slug: "buf", name: "Buffer Salon", ownerEmail: "b@example.com" });
  const { bookAppointment, SchedulingConflictError } = await import("../src/domain/booking.ts");
  const { addStaff } = await import("../src/domain/catalogue.ts");

  // 45-minute service with a 15-minute turnaround: occupies the chair from 10:00 to 11:00.
  const base = { locationId: a.locationId, customerId: a.customerId, serviceId: a.serviceId, staffId: a.staffId, resourceId: a.chairId, now: T0 };
  await bookAppointment(a.ctx, { ...base, startsAt: T0 + 60 * MIN });

  // A second stylist, so the clash can only be about the chair.
  const other = await addStaff(a.ctx, { locationId: a.locationId, displayName: "Ravi", now: T0 });

  await assert.rejects(
    () => bookAppointment(a.ctx, { ...base, staffId: other, startsAt: T0 + 105 * MIN }),
    SchedulingConflictError,
    "a booking starting inside the turnaround buffer was accepted",
  );
  // One minute past the buffer is fine.
  assert.ok(await bookAppointment(a.ctx, { ...base, staffId: other, startsAt: T0 + 120 * MIN }));
});

test("LOOP-05 a staff member cannot be double-booked", async () => {
  const { db } = await world();
  const a = await seedTenant(db, { slug: "dbl", name: "Double Salon", ownerEmail: "d@example.com" });
  const { bookAppointment, SchedulingConflictError } = await import("../src/domain/booking.ts");
  const { addResource } = await import("../src/domain/catalogue.ts");

  const base = { locationId: a.locationId, customerId: a.customerId, serviceId: a.serviceId, staffId: a.staffId, resourceId: a.chairId, now: T0 };
  await bookAppointment(a.ctx, { ...base, startsAt: T0 + 60 * MIN });

  // A free second chair, so the clash can only be about the stylist.
  const chair2 = await addResource(a.ctx, { locationId: a.locationId, kind: "chair", name: "Chair 2", now: T0 });
  await assert.rejects(
    () => bookAppointment(a.ctx, { ...base, resourceId: chair2, startsAt: T0 + 75 * MIN }),
    SchedulingConflictError,
  );
});

test("LOOP-06 cancelling frees both the staff member and the resource", async () => {
  const { db } = await world();
  const a = await seedTenant(db, { slug: "cnl", name: "Cancel Salon", ownerEmail: "c@example.com" });
  const { bookAppointment, cancelAppointment } = await import("../src/domain/booking.ts");

  const base = { locationId: a.locationId, customerId: a.customerId, serviceId: a.serviceId, staffId: a.staffId, resourceId: a.chairId, startsAt: T0 + 60 * MIN, now: T0 };
  const first = await bookAppointment(a.ctx, base);
  assert.equal(await cancelAppointment(a.ctx, first, "customer called"), true);
  assert.ok(await bookAppointment(a.ctx, base), "the freed slot could not be rebooked");

  // Cancelling twice is not an error and not a second cancellation.
  assert.equal(await cancelAppointment(a.ctx, first, "again"), false);
});

test("LOOP-07 a service that needs no resource books without one", async () => {
  const { db } = await world();
  const a = await seedTenant(db, { slug: "csl", name: "Consult Clinic", vertical: "clinic", ownerEmail: "cl@example.com" });
  const { addService } = await import("../src/domain/catalogue.ts");
  const { bookAppointment } = await import("../src/domain/booking.ts");

  const phoneConsult = await addService(a.ctx, {
    name: "Teleconsult", durationMinutes: 15, priceMinor: 30000, currency: "INR", now: T0,
  });
  const id = await bookAppointment(a.ctx, {
    locationId: a.locationId, customerId: a.customerId, serviceId: phoneConsult, staffId: a.staffId, startsAt: T0 + 60 * MIN, now: T0,
  });
  assert.equal((await a.ctx.first("appointments", { id })).resource_id, null);
});

test("LOOP-08 one engine, four verticals", async () => {
  const { db } = await world();
  const { addResource, addService } = await import("../src/domain/catalogue.ts");
  const { bookAppointment } = await import("../src/domain/booking.ts");

  // Same four calls each time. Only the labels and the resource kind change.
  const shapes = [
    { slug: "v-salon", name: "Salon", vertical: "salon", kind: "chair", resource: "Chair 1", service: "Hair Colour", minutes: 120 },
    { slug: "v-spa", name: "Spa", vertical: "spa", kind: "room", resource: "Room 2", service: "Deep Tissue Massage", minutes: 60 },
    { slug: "v-pets", name: "Pet Spa", vertical: "pet_grooming", kind: "table", resource: "Grooming Table", service: "Full Groom", minutes: 90 },
    { slug: "v-clinic", name: "Clinic", vertical: "clinic", kind: "bay", resource: "Operatory 1", service: "Scale & Polish", minutes: 30 },
  ];

  for (const shape of shapes) {
    const t = await seedTenant(db, { slug: shape.slug, name: shape.name, vertical: shape.vertical, ownerEmail: `${shape.slug}@example.com` });
    const resourceId = await addResource(t.ctx, { locationId: t.locationId, kind: shape.kind, name: shape.resource, now: T0 });
    const serviceId = await addService(t.ctx, {
      name: shape.service, durationMinutes: shape.minutes, priceMinor: 150000, currency: "INR", resourceKind: shape.kind, now: T0,
    });
    const id = await bookAppointment(t.ctx, {
      locationId: t.locationId, customerId: t.customerId, serviceId, staffId: t.staffId, resourceId, startsAt: T0 + 180 * MIN, now: T0,
    });
    const row = await t.ctx.first("appointments", { id });
    assert.equal(row.ends_at - row.starts_at, shape.minutes * MIN, `${shape.name} booked the wrong duration`);
  }
});

test("LOOP-09 a service cannot be booked onto the wrong kind of resource", async () => {
  const { db } = await world();
  const a = await seedTenant(db, { slug: "kind", name: "Kind Spa", vertical: "spa", ownerEmail: "k@example.com" });
  const { addResource } = await import("../src/domain/catalogue.ts");
  const { bookAppointment } = await import("../src/domain/booking.ts");

  // The seeded Haircut needs a chair. Offering it a massage room must fail.
  const room = await addResource(a.ctx, { locationId: a.locationId, kind: "room", name: "Room 1", now: T0 });
  await assert.rejects(
    () => bookAppointment(a.ctx, {
      locationId: a.locationId, customerId: a.customerId, serviceId: a.serviceId, staffId: a.staffId, resourceId: room, startsAt: T0 + 60 * MIN, now: T0,
    }),
    /requires a chair, not a room/,
  );
});

test("LOOP-10 roles gate the loop: staff may look, front desk may book", async () => {
  const { db } = await world();
  const a = await seedTenant(db, { slug: "roles", name: "Roles Salon", ownerEmail: "r@example.com" });
  const { TenantContext } = await import("../src/tenancy/context.ts");
  const { resolveIdentity, grantMembership } = await import("../src/tenancy/provisioning.ts");
  const { PermissionDeniedError } = await import("../src/tenancy/rbac.ts");
  const { bookAppointment } = await import("../src/domain/booking.ts");

  const base = { locationId: a.locationId, customerId: a.customerId, serviceId: a.serviceId, staffId: a.staffId, resourceId: a.chairId, startsAt: T0 + 60 * MIN, now: T0 };

  const stylistId = await resolveIdentity(db, { email: "stylist@roles.in", displayName: "Stylist", now: T0 });
  await grantMembership(db, { tenantId: a.tenantId, identityId: stylistId, role: "staff", now: T0 });
  const stylist = await TenantContext.open(db, { identityId: stylistId, tenantId: a.tenantId, now: T0 });
  await assert.rejects(() => bookAppointment(stylist, base), PermissionDeniedError);
  assert.ok(await stylist.all("appointments"), "staff cannot read the diary they work from");

  const deskId = await resolveIdentity(db, { email: "desk@roles.in", displayName: "Desk", now: T0 });
  await grantMembership(db, { tenantId: a.tenantId, identityId: deskId, role: "front_desk", now: T0 });
  const desk = await TenantContext.open(db, { identityId: deskId, tenantId: a.tenantId, now: T0 });
  assert.ok(await bookAppointment(desk, base));

  // And front desk still cannot refund.
  assert.equal(desk.can("payments.refund"), false);
});

test("LOOP-11 every step of the loop lands in the tenant's audit trail", async () => {
  const { db } = await world();
  const a = await seedTenant(db, { slug: "aud", name: "Audit Salon", ownerEmail: "a@example.com" });
  const { bookAppointment } = await import("../src/domain/booking.ts");

  await bookAppointment(a.ctx, {
    locationId: a.locationId, customerId: a.customerId, serviceId: a.serviceId, staffId: a.staffId, resourceId: a.chairId, startsAt: T0 + 60 * MIN, now: T0,
  });

  const actions = (await a.ctx.all("audit_log", {}, { orderBy: "at" })).map((row) => row.action);
  for (const expected of ["brand.create", "location.create", "staff.add", "resource.add", "service.add", "customer.create", "appointment.book"]) {
    assert.ok(actions.includes(expected), `no audit entry for ${expected}`);
  }
  const entry = (await a.ctx.all("audit_log", { action: "appointment.book" }))[0];
  assert.equal(entry.actor_identity_id, a.ownerIdentityId);
  assert.equal(entry.actor_role, "owner");
});
