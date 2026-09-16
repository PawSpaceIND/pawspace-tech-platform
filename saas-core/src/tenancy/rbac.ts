/**
 * Roles are per-tenant, not global.
 *
 * PawSpace's nine roles (founder, superuser, admin, manager, associate, customer, service_provider,
 * finance, auditor) are a flat platform-wide list, which is correct for a single-operator product
 * and fatal for a SaaS: "admin" there means admin of everything. Here a role is only ever held
 * through a membership row, so it means admin OF ONE TENANT, and the same person can be an owner in
 * one salon and a stylist in another.
 *
 * Platform staff are deliberately NOT in this enum. Support access to a tenant is a separate,
 * audited, time-boxed grant rather than a role that quietly outranks the owner.
 */

export const ROLES = ["owner", "manager", "front_desk", "staff", "accountant"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "appointments.read",
  "appointments.book",
  "appointments.manage",
  "customers.read",
  "customers.manage",
  "services.manage",
  "staff.manage",
  "resources.manage",
  "payments.collect",
  "payments.refund",
  "reports.read",
  "billing.manage",
  "settings.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Deliberately enumerated per role rather than derived from a rank order. A hierarchy where each
 * role silently inherits the one below invites exactly the bug this product cannot have — a
 * front_desk quietly gaining payments.refund because someone reordered the list.
 */
const GRANTS: Record<Role, readonly Permission[]> = {
  owner: [
    "appointments.read", "appointments.book", "appointments.manage",
    "customers.read", "customers.manage",
    "services.manage", "staff.manage", "resources.manage",
    "payments.collect", "payments.refund",
    "reports.read", "billing.manage", "settings.manage",
  ],
  manager: [
    "appointments.read", "appointments.book", "appointments.manage",
    "customers.read", "customers.manage",
    "services.manage", "staff.manage", "resources.manage",
    "payments.collect", "payments.refund",
    "reports.read",
  ],
  front_desk: [
    "appointments.read", "appointments.book", "appointments.manage",
    "customers.read", "customers.manage",
    "payments.collect",
  ],
  staff: [
    "appointments.read",
    "customers.read",
  ],
  accountant: [
    "appointments.read",
    "customers.read",
    "payments.collect", "payments.refund",
    "reports.read",
  ],
};

export function permissionsFor(role: Role): readonly Permission[] {
  return GRANTS[role] ?? [];
}

export function roleHas(role: Role, permission: Permission): boolean {
  return (GRANTS[role] ?? []).includes(permission);
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export class PermissionDeniedError extends Error {
  readonly permission: Permission;
  readonly role: Role;

  constructor(permission: Permission, role: Role) {
    super(`Role ${role} does not hold ${permission}`);
    this.name = "PermissionDeniedError";
    this.permission = permission;
    this.role = role;
  }
}
