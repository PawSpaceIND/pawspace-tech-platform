/**
 * Every table in the core, and the isolation class each one belongs to.
 *
 * The single most important rule in this codebase: an operational row belongs to exactly one tenant,
 * and that ownership is part of its primary key. Two tenants can both have a customer with id
 * "cust_1" and the database itself keeps them apart — there is no id space shared across tenants
 * where a bug could make one resolve to the other.
 *
 * Tables are registered into one of three classes and nothing may be queried through a
 * TenantContext unless it is registered here. Adding a table without classifying it is a compile-
 * free but test-caught error, which is deliberate: the isolation battery fails loudly rather than
 * letting an unclassified table become a silent leak.
 */

import type { Database } from "../db/types.ts";

/** Defines who tenants are. Never filtered by tenant — reading it IS the platform boundary. */
export const PLATFORM_SCOPED = new Set(["tenants", "identities"]);

/** Links an identity to a tenant. Read before a TenantContext exists, so it cannot go through one. */
export const BRIDGE_SCOPED = new Set(["memberships"]);

/** Operational data. Every row carries tenant_id; every read injects it. */
export const TENANT_SCOPED = new Set([
  "brands",
  "locations",
  "staff",
  "resources",
  "services",
  "service_staff",
  "customers",
  "appointments",
  "audit_log",
]);

/**
 * Which column narrows a row to a branch, for members whose access is scoped to specific locations.
 *
 * `locations` is the special case: the branch identity IS its primary key, not a foreign key, so a
 * location-scoped manager reading the branch list filters on `id`. Getting this wrong in either
 * direction is a leak (wrong column) or a lockout (no column), so it is one lookup, not a
 * convention spread across call sites.
 */
export function locationColumn(table: string): string | null {
  if (table === "locations") return "id";
  if (table === "staff" || table === "resources" || table === "appointments") return "location_id";
  return null;
}

export function isTenantScoped(table: string): boolean {
  return TENANT_SCOPED.has(table);
}

const DDL = [
  /* ---------- platform ---------- */

  `CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    vertical TEXT NOT NULL,
    status TEXT NOT NULL,
    trial_ends_at INTEGER,
    created_at INTEGER NOT NULL
  )`,

  /*
   * One login per human, platform-wide. This is the table PawSpace's app_users.email UNIQUE was
   * trying to be, and the reason that constraint broke multi-tenancy there is that app_users
   * conflated "who can log in" with "who is a customer of this business". Here they are separate:
   * a stylist working weekends at two salons has ONE identity and TWO memberships, and a person who
   * is a customer of two salons has no identity at all — just two unrelated `customers` rows.
   */
  `CREATE TABLE IF NOT EXISTS identities (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    phone TEXT,
    display_name TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,

  /* ---------- bridge ---------- */

  `CREATE TABLE IF NOT EXISTS memberships (
    tenant_id TEXT NOT NULL,
    identity_id TEXT NOT NULL,
    role TEXT NOT NULL,
    location_scope TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, identity_id)
  )`,

  /* ---------- tenant-scoped operations ---------- */

  `CREATE TABLE IF NOT EXISTS brands (
    tenant_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, id)
  )`,

  `CREATE TABLE IF NOT EXISTS locations (
    tenant_id TEXT NOT NULL,
    id TEXT NOT NULL,
    brand_id TEXT NOT NULL,
    name TEXT NOT NULL,
    timezone TEXT NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, id)
  )`,

  `CREATE TABLE IF NOT EXISTS staff (
    tenant_id TEXT NOT NULL,
    id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    identity_id TEXT,
    display_name TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, id)
  )`,

  /*
   * A chair, a room, a grooming table, a dental chair, a laser unit. The vertical templates differ
   * only in which `kind` values they preset and what they call them in the UI — the scheduling
   * engine that consumes this table does not care.
   */
  `CREATE TABLE IF NOT EXISTS resources (
    tenant_id TEXT NOT NULL,
    id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    capacity INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, id)
  )`,

  `CREATE TABLE IF NOT EXISTS services (
    tenant_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL,
    buffer_before_minutes INTEGER NOT NULL,
    buffer_after_minutes INTEGER NOT NULL,
    price_minor INTEGER NOT NULL,
    currency TEXT NOT NULL,
    resource_kind TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, id)
  )`,

  `CREATE TABLE IF NOT EXISTS service_staff (
    tenant_id TEXT NOT NULL,
    service_id TEXT NOT NULL,
    staff_id TEXT NOT NULL,
    PRIMARY KEY (tenant_id, service_id, staff_id)
  )`,

  `CREATE TABLE IF NOT EXISTS customers (
    tenant_id TEXT NOT NULL,
    id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, id)
  )`,

  /*
   * Unique WITHIN a tenant, never across. The same person may be a customer of four salons under one
   * email address, and none of those salons learns about the other three.
   */
  `CREATE UNIQUE INDEX IF NOT EXISTS customers_tenant_email
     ON customers (tenant_id, email) WHERE email IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS appointments (
    tenant_id TEXT NOT NULL,
    id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    service_id TEXT NOT NULL,
    staff_id TEXT,
    resource_id TEXT,
    starts_at INTEGER NOT NULL,
    ends_at INTEGER NOT NULL,
    occupies_from INTEGER NOT NULL,
    occupies_to INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, id)
  )`,

  /*
   * The scheduler searches by OCCUPIED window, not by the customer-facing time. A 60-minute massage
   * with a 15-minute turnaround shows the customer 10:00-11:00 and holds the room until 11:15, and
   * the collision check has to see the second number or it will book someone into the turnaround.
   */
  `CREATE INDEX IF NOT EXISTS appointments_tenant_window
     ON appointments (tenant_id, location_id, occupies_from)`,

  `CREATE TABLE IF NOT EXISTS audit_log (
    tenant_id TEXT NOT NULL,
    id TEXT NOT NULL,
    at INTEGER NOT NULL,
    actor_identity_id TEXT NOT NULL,
    actor_role TEXT NOT NULL,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    detail TEXT NOT NULL,
    PRIMARY KEY (tenant_id, id)
  )`,
];

let ensured = false;

/** Idempotent. Safe to call on every request; the work happens once per isolate. */
export async function ensureCoreSchema(db: Database): Promise<void> {
  if (ensured) return;
  for (const statement of DDL) await db.prepare(statement).run();
  ensured = true;
}

/** Tests build many databases in one process, so they reset the memo between worlds. */
export function resetSchemaMemo(): void {
  ensured = false;
}
