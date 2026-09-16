/**
 * Staff, resources and services — the three things every vertical configures and the scheduling
 * engine consumes.
 *
 * Nothing here knows what industry it is in. A "resource" of kind `chair` at a barber, `room` at a
 * spa, `table` at a pet groomer and `operatory` at a dental clinic are the same row with a
 * different label, and the vertical templates are presets over this, not subclasses of it.
 */

import type { TenantContext } from "../tenancy/context.ts";
import { newId } from "../db/ids.ts";

export const RESOURCE_KINDS = ["chair", "room", "table", "station", "equipment", "bay"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export type StaffInput = { locationId: string; displayName: string; identityId?: string; now?: number };

export async function addStaff(ctx: TenantContext, input: StaffInput): Promise<string> {
  ctx.require("staff.manage");
  const id = newId("stf");
  await ctx.insert("staff", {
    id,
    location_id: input.locationId,
    identity_id: input.identityId ?? null,
    display_name: input.displayName.trim(),
    status: "active",
    created_at: input.now ?? Date.now(),
  });
  await ctx.audit({ action: "staff.add", entity: "staff", entityId: id, detail: { name: input.displayName } });
  return id;
}

export type ResourceInput = {
  locationId: string;
  kind: ResourceKind;
  name: string;
  capacity?: number;
  now?: number;
};

export async function addResource(ctx: TenantContext, input: ResourceInput): Promise<string> {
  ctx.require("resources.manage");
  const id = newId("res");
  await ctx.insert("resources", {
    id,
    location_id: input.locationId,
    kind: input.kind,
    name: input.name.trim(),
    capacity: input.capacity ?? 1,
    status: "active",
    created_at: input.now ?? Date.now(),
  });
  await ctx.audit({ action: "resource.add", entity: "resource", entityId: id, detail: { kind: input.kind } });
  return id;
}

export type ServiceInput = {
  name: string;
  durationMinutes: number;
  priceMinor: number;
  currency: string;
  /** Which kind of resource this service occupies, if any. A consultation may need none. */
  resourceKind?: ResourceKind;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  now?: number;
};

export async function addService(ctx: TenantContext, input: ServiceInput): Promise<string> {
  ctx.require("services.manage");
  if (input.durationMinutes <= 0) throw new Error("Service duration must be positive");
  const id = newId("svc");
  await ctx.insert("services", {
    id,
    name: input.name.trim(),
    duration_minutes: Math.trunc(input.durationMinutes),
    buffer_before_minutes: Math.trunc(input.bufferBeforeMinutes ?? 0),
    buffer_after_minutes: Math.trunc(input.bufferAfterMinutes ?? 0),
    price_minor: Math.trunc(input.priceMinor),
    currency: input.currency.toUpperCase(),
    resource_kind: input.resourceKind ?? null,
    status: "active",
    created_at: input.now ?? Date.now(),
  });
  await ctx.audit({ action: "service.add", entity: "service", entityId: id, detail: { name: input.name } });
  return id;
}

/** Who is qualified to perform what. An empty list for a service means anyone at the location. */
export async function qualifyStaff(ctx: TenantContext, serviceId: string, staffId: string): Promise<void> {
  ctx.require("services.manage");
  const service = await ctx.first("services", { id: serviceId });
  if (!service) throw new Error("Service not found in this tenant");
  const staff = await ctx.first("staff", { id: staffId });
  if (!staff) throw new Error("Staff member not found in this tenant");
  await ctx.insert("service_staff", { service_id: serviceId, staff_id: staffId });
}

export async function qualifiedStaffIds(ctx: TenantContext, serviceId: string): Promise<string[]> {
  const rows = await ctx.all<{ staff_id: string }>("service_staff", { service_id: serviceId });
  return rows.map((row) => row.staff_id);
}
