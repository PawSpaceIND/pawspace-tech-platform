/**
 * Creating a tenant, and everything that has to be true the moment one exists.
 *
 * This runs outside a TenantContext for the obvious reason that there is no tenant to scope to yet.
 * It is the one place in the platform allowed to write tenant-owning rows directly, and it is kept
 * small so that "code that can write across tenants" stays a list of about four functions rather
 * than a property of the codebase.
 */

import type { Database } from "../db/types.ts";
import { newId } from "../db/ids.ts";
import { ensureCoreSchema } from "./schema.ts";
import { TenantContext } from "./context.ts";
import type { Role } from "./rbac.ts";

export const VERTICALS = [
  "salon",
  "spa",
  "pet_grooming",
  "barber",
  "nails",
  "wellness",
  "clinic",
  "other",
] as const;
export type Vertical = (typeof VERTICALS)[number];

const TRIAL_DAYS = 7;
const DAY_MS = 86_400_000;

export type ProvisionRequest = {
  slug: string;
  name: string;
  vertical: Vertical;
  owner: { email: string; displayName: string; phone?: string };
  now?: number;
};

export type ProvisionResult = {
  tenantId: string;
  ownerIdentityId: string;
  trialEndsAt: number;
};

/**
 * Signup. Creates the tenant, resolves or creates the owner's platform identity, and grants the
 * owner membership.
 *
 * Identity is resolved by email and REUSED when it already exists, which is the whole point of
 * separating identity from membership: someone who already owns a salon and opens a second one
 * signs in with the account they have, and ends up with two memberships rather than two logins.
 */
export async function provisionTenant(db: Database, request: ProvisionRequest): Promise<ProvisionResult> {
  await ensureCoreSchema(db);
  const now = request.now ?? Date.now();
  const email = request.owner.email.trim().toLowerCase();
  if (!email.includes("@")) throw new Error("A valid owner email is required");

  const slug = request.slug.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(slug)) {
    throw new Error("Slug must be lowercase alphanumeric with hyphens, 3-50 characters");
  }

  const identityId = await resolveIdentity(db, {
    email,
    displayName: request.owner.displayName,
    phone: request.owner.phone,
    now,
  });

  const tenantId = newId("ten");
  const trialEndsAt = now + TRIAL_DAYS * DAY_MS;

  await db
    .prepare(
      `INSERT INTO tenants (id, slug, name, vertical, status, trial_ends_at, created_at)
       VALUES (?, ?, ?, ?, 'trialing', ?, ?)`,
    )
    .bind(tenantId, slug, request.name.trim(), request.vertical, trialEndsAt, now)
    .run();

  await grantMembership(db, { tenantId, identityId, role: "owner", now });

  return { tenantId, ownerIdentityId: identityId, trialEndsAt };
}

/** Returns the existing identity for this email, or creates one. */
export async function resolveIdentity(
  db: Database,
  input: { email: string; displayName: string; phone?: string; now?: number },
): Promise<string> {
  await ensureCoreSchema(db);
  const email = input.email.trim().toLowerCase();
  const existing = await db
    .prepare("SELECT id FROM identities WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  if (existing) return existing.id;

  const id = newId("idn");
  await db
    .prepare(
      `INSERT INTO identities (id, email, phone, display_name, status, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
    )
    .bind(id, email, input.phone ?? null, input.displayName.trim(), input.now ?? Date.now())
    .run();
  return id;
}

export type MembershipGrant = {
  tenantId: string;
  identityId: string;
  role: Role;
  /** "all" or an explicit list of location ids. Absent means all. */
  locationScope?: "all" | readonly string[];
  now?: number;
};

export async function grantMembership(db: Database, grant: MembershipGrant): Promise<void> {
  const scope = grant.locationScope ?? "all";
  await db
    .prepare(
      `INSERT INTO memberships (tenant_id, identity_id, role, location_scope, status, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)
       ON CONFLICT (tenant_id, identity_id)
       DO UPDATE SET role = excluded.role, location_scope = excluded.location_scope, status = 'active'`,
    )
    .bind(
      grant.tenantId,
      grant.identityId,
      grant.role,
      scope === "all" ? "all" : JSON.stringify(scope),
      grant.now ?? Date.now(),
    )
    .run();
}

export async function revokeMembership(db: Database, tenantId: string, identityId: string): Promise<void> {
  await db
    .prepare("UPDATE memberships SET status = 'revoked' WHERE tenant_id = ? AND identity_id = ?")
    .bind(tenantId, identityId)
    .run();
}

/** Every tenant a person can sign into, for the account switcher. */
export async function tenantsForIdentity(
  db: Database,
  identityId: string,
): Promise<{ tenantId: string; name: string; slug: string; role: Role }[]> {
  const result = await db
    .prepare(
      `SELECT t.id AS tenantId, t.name AS name, t.slug AS slug, m.role AS role
         FROM memberships m
         JOIN tenants t ON t.id = m.tenant_id
        WHERE m.identity_id = ? AND m.status = 'active'
          AND t.status IN ('trialing', 'active')
        ORDER BY t.name ASC`,
    )
    .bind(identityId)
    .all<{ tenantId: string; name: string; slug: string; role: Role }>();
  return result.results ?? [];
}

/* ---------------- inside the tenant ---------------- */

export async function createBrand(ctx: TenantContext, name: string, now = Date.now()): Promise<string> {
  ctx.require("settings.manage");
  const id = newId("brd");
  await ctx.insert("brands", { id, name: name.trim(), created_at: now });
  await ctx.audit({ action: "brand.create", entity: "brand", entityId: id, detail: { name } });
  return id;
}

export type LocationInput = {
  brandId: string;
  name: string;
  timezone: string;
  currency: string;
  now?: number;
};

export async function createLocation(ctx: TenantContext, input: LocationInput): Promise<string> {
  ctx.require("settings.manage");
  const brand = await ctx.first("brands", { id: input.brandId });
  if (!brand) throw new Error("Brand not found in this tenant");

  const id = newId("loc");
  const now = input.now ?? Date.now();
  // A branch-scoped member cannot create a branch: ctx.insert scopes `locations` on its own `id`,
  // and a freshly minted id is never inside an existing scope, so the write is refused. That falls
  // out of the scoping rule rather than needing a check here, which is the point of the design.
  await ctx.insert("locations", {
    id,
    brand_id: input.brandId,
    name: input.name.trim(),
    timezone: input.timezone,
    currency: input.currency.toUpperCase(),
    status: "active",
    created_at: now,
  });
  await ctx.audit({ action: "location.create", entity: "location", entityId: id, detail: { name: input.name } });
  return id;
}
