/**
 * Customers and appointments.
 *
 * The scheduling rule this engine enforces is the one every appointment business shares: a booking
 * occupies a member of STAFF and, when the service needs one, a RESOURCE, for the service duration
 * plus its buffers. A stylist and their colour station, a therapist and their room, a groomer and
 * their table, a dentist and their operatory — one collision check covers all four.
 *
 * Buffers are part of the occupied window, not decoration. A 60-minute massage with a 15-minute
 * turnaround occupies the room for 75 minutes, and a room booked back-to-back without that gap is
 * the single most common real-world scheduling complaint.
 */

import type { TenantContext } from "../tenancy/context.ts";
import { newId } from "../db/ids.ts";

export type CustomerInput = { displayName: string; email?: string; phone?: string; now?: number };

export async function createCustomer(ctx: TenantContext, input: CustomerInput): Promise<string> {
  ctx.require("customers.manage");
  const id = newId("cus");
  await ctx.insert("customers", {
    id,
    display_name: input.displayName.trim(),
    email: input.email?.trim().toLowerCase() ?? null,
    phone: input.phone?.trim() ?? null,
    created_at: input.now ?? Date.now(),
  });
  await ctx.audit({ action: "customer.create", entity: "customer", entityId: id, detail: {} });
  return id;
}

export type BookingRequest = {
  locationId: string;
  customerId: string;
  serviceId: string;
  staffId: string;
  startsAt: number;
  /** Optional when the service declares no resource_kind; required when it does. */
  resourceId?: string;
  now?: number;
};

export class SchedulingConflictError extends Error {
  readonly subject: "staff" | "resource";
  readonly conflictingAppointmentId: string;

  constructor(subject: "staff" | "resource", conflictingAppointmentId: string) {
    super(`The requested ${subject} is already booked`);
    this.name = "SchedulingConflictError";
    this.subject = subject;
    this.conflictingAppointmentId = conflictingAppointmentId;
  }
}

const MINUTE_MS = 60_000;

/**
 * The occupied window: the service itself, widened by its buffers at each end.
 * Exported because availability search and conflict detection must agree on it exactly.
 */
export function occupiedWindow(
  startsAt: number,
  service: { duration_minutes: number; buffer_before_minutes: number; buffer_after_minutes: number },
): { from: number; to: number; endsAt: number } {
  const endsAt = startsAt + service.duration_minutes * MINUTE_MS;
  return {
    from: startsAt - service.buffer_before_minutes * MINUTE_MS,
    to: endsAt + service.buffer_after_minutes * MINUTE_MS,
    endsAt,
  };
}

export async function bookAppointment(ctx: TenantContext, request: BookingRequest): Promise<string> {
  ctx.require("appointments.book");

  // Every referenced entity is fetched through the context, so a request naming another tenant's
  // customer or service fails as "not found" rather than booking across the boundary.
  const customer = await ctx.first("customers", { id: request.customerId });
  if (!customer) throw new Error("Customer not found in this tenant");

  const service = await ctx.first<{
    id: string;
    duration_minutes: number;
    buffer_before_minutes: number;
    buffer_after_minutes: number;
    resource_kind: string | null;
  }>("services", { id: request.serviceId });
  if (!service) throw new Error("Service not found in this tenant");

  const staff = await ctx.first<{ id: string; location_id: string }>("staff", { id: request.staffId });
  if (!staff) throw new Error("Staff member not found in this tenant");
  if (staff.location_id !== request.locationId) throw new Error("Staff member does not work at this location");

  let resourceId: string | null = null;
  if (service.resource_kind) {
    if (!request.resourceId) throw new Error(`This service requires a ${service.resource_kind}`);
    const resource = await ctx.first<{ id: string; kind: string; location_id: string }>("resources", {
      id: request.resourceId,
    });
    if (!resource) throw new Error("Resource not found in this tenant");
    if (resource.kind !== service.resource_kind) {
      throw new Error(`Service requires a ${service.resource_kind}, not a ${resource.kind}`);
    }
    if (resource.location_id !== request.locationId) throw new Error("Resource is at a different location");
    resourceId = resource.id;
  }

  const window = occupiedWindow(request.startsAt, service);

  const staffClash = await overlapping(ctx, "staff_id", request.staffId, window);
  if (staffClash) throw new SchedulingConflictError("staff", staffClash);

  if (resourceId) {
    const resourceClash = await overlapping(ctx, "resource_id", resourceId, window);
    if (resourceClash) throw new SchedulingConflictError("resource", resourceClash);
  }

  const id = newId("apt");
  await ctx.insert("appointments", {
    id,
    location_id: request.locationId,
    customer_id: request.customerId,
    service_id: request.serviceId,
    staff_id: request.staffId,
    resource_id: resourceId,
    starts_at: request.startsAt,
    ends_at: window.endsAt,
    occupies_from: window.from,
    occupies_to: window.to,
    status: "booked",
    created_at: request.now ?? Date.now(),
  });
  await ctx.audit({
    action: "appointment.book",
    entity: "appointment",
    entityId: id,
    detail: { serviceId: request.serviceId, startsAt: request.startsAt },
  });
  return id;
}

/**
 * Returns the id of an appointment already holding this staff member or resource across the window,
 * or null.
 *
 * Compares OCCUPIED window against OCCUPIED window. Comparing the new booking's buffered window
 * against the existing row's `starts_at`/`ends_at` looks right and is wrong in one direction only:
 * buffers on the EXISTING appointment are ignored, so a booking lands inside another's turnaround.
 * That asymmetry is invisible in a test that only books forwards, which is why LOOP-04 books into
 * the gap deliberately.
 *
 * Runs through rawTenantQuery because the overlap predicate is a range comparison the equality
 * builder cannot express — exactly the case the escape hatch exists for. The tenant predicate is
 * still bound first and still mandatory.
 */
async function overlapping(
  ctx: TenantContext,
  column: "staff_id" | "resource_id",
  value: string,
  window: { from: number; to: number },
): Promise<string | null> {
  const rows = await ctx.rawTenantQuery<{ id: string }>(
    `SELECT id FROM appointments
      WHERE tenant_id = ?
        AND ${column} = ?
        AND status IN ('booked', 'in_progress')
        AND occupies_from < ?
        AND occupies_to > ?
      LIMIT 1`,
    [value, window.to, window.from],
    `overlap check on ${column}`,
  );
  return rows[0]?.id ?? null;
}

export async function cancelAppointment(ctx: TenantContext, appointmentId: string, reason: string): Promise<boolean> {
  ctx.require("appointments.manage");
  const changed = await ctx.update("appointments", { status: "cancelled" }, { id: appointmentId, status: "booked" });
  if (changed === 0) return false;
  await ctx.audit({ action: "appointment.cancel", entity: "appointment", entityId: appointmentId, detail: { reason } });
  return true;
}
