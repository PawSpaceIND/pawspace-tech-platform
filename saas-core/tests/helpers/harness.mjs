/*
 * A real SQLite engine behind the D1 interface.
 *
 * Adapted from the PawSpace execution harness, which proved the point worth keeping: this is an
 * ADAPTER, not a mock. The module under test runs its real SQL against a real engine, so a query
 * that would fail on D1 for a syntax or constraint reason fails here too. A mocked database would
 * happily accept a statement that leaks across tenants, which would make the isolation battery
 * worthless.
 */
import { DatabaseSync } from "node:sqlite";

export function d1(sqlite) {
  const statement = (sql, args) => ({
    sql,
    bind: (...bound) => statement(sql, bound),
    first: async (col) => {
      const row = sqlite.prepare(sql).get(...args);
      if (row === undefined) return null;
      return col ? row[col] : row;
    },
    run: async () => {
      const info = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid || 0) } };
    },
    all: async () => ({ results: sqlite.prepare(sql).all(...args), success: true, meta: {} }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const s of list) out.push(await s.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

/** A fresh in-memory database with the core schema applied. */
export async function world() {
  const { ensureCoreSchema, resetSchemaMemo } = await import("../../src/tenancy/schema.ts");
  const sqlite = new DatabaseSync(":memory:");
  const db = d1(sqlite);
  resetSchemaMemo();
  await ensureCoreSchema(db);
  return { sqlite, db };
}

export const T0 = Date.UTC(2026, 8, 16, 9, 0, 0);

/**
 * A complete tenant with one brand, one branch, one staff member, one chair and one service.
 *
 * Every test in the isolation battery needs two of these, so building one is a single call and the
 * tests read as assertions rather than as setup.
 */
export async function seedTenant(db, { slug, name, vertical = "salon", ownerEmail, now = T0 }) {
  const { provisionTenant } = await import("../../src/tenancy/provisioning.ts");
  const { createBrand, createLocation } = await import("../../src/tenancy/provisioning.ts");
  const { TenantContext } = await import("../../src/tenancy/context.ts");
  const { addStaff, addResource, addService } = await import("../../src/domain/catalogue.ts");
  const { createCustomer } = await import("../../src/domain/booking.ts");

  const tenant = await provisionTenant(db, {
    slug,
    name,
    vertical,
    owner: { email: ownerEmail, displayName: `${name} Owner` },
    now,
  });
  const ctx = await TenantContext.open(db, {
    identityId: tenant.ownerIdentityId,
    tenantId: tenant.tenantId,
    now,
  });
  const brandId = await createBrand(ctx, name, now);
  const locationId = await createLocation(ctx, {
    brandId,
    name: `${name} Main`,
    timezone: "Asia/Kolkata",
    currency: "INR",
    now,
  });
  const staffId = await addStaff(ctx, { locationId, displayName: "Priya", now });
  const chairId = await addResource(ctx, { locationId, kind: "chair", name: "Chair 1", now });
  const serviceId = await addService(ctx, {
    name: "Haircut",
    durationMinutes: 45,
    priceMinor: 80000,
    currency: "INR",
    resourceKind: "chair",
    bufferAfterMinutes: 15,
    now,
  });
  const customerId = await createCustomer(ctx, { displayName: "Anita", email: "anita@example.com", now });

  return { ...tenant, ctx, brandId, locationId, staffId, chairId, serviceId, customerId };
}
