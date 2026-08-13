/**
 * Who is allowed to act on a staff alert.
 *
 * The alert centre raises work for several different teams through one queue: lead SLA breaches for
 * Sales, case escalations for Operations, host-acceptance timeouts for Operations, and failed
 * payments for Finance. Until this module existed, /api/staff-alerts gated the whole POST on a single
 * `customers.manage` check, which produced the wrong answer in both directions at once:
 *
 *   - A Manager holds `customers.manage` and no Finance permission, and could resolve a *critical*
 *     `payment_failure` alert - closing Finance's follow-up on real money without the authority to
 *     judge whether it had actually been dealt with.
 *   - The Finance role does NOT hold `customers.manage` (lib/platform-security.ts:26), so the team
 *     that owns those alerts was refused at the door entirely.
 *
 * So the fix is not "require more" - it is to ask the question per alert: this alert belongs to a
 * team and a domain, and the actor must hold that domain's authority.
 *
 * Two deliberate properties:
 *
 *   1. **Fail closed.** An alert type with no policy is refused to everyone except a platform owner
 *      (`*`). A new alert type added without a policy entry becomes visibly un-actionable rather than
 *      quietly actionable by anyone holding a common permission - which is the failure this module
 *      exists to end.
 *   2. **The addressee may act.** Alerts routed to a named person (`recipient_email`) are their work,
 *      so they may acknowledge and resolve their own alert without holding the team-wide permission -
 *      an Associate owning a lead can close their own SLA alert. Finance alerts are excluded from
 *      this: money is never closed by addressing alone.
 */
import { hasPermission, type Permission } from "./platform-security";

export type StaffAlertAuthority = {
  /** Holding ANY of these authorises the action. Empty means platform owners (`*`) only. */
  permissions: Permission[];
  /** May the person the alert is addressed to act without holding one of the permissions above? */
  assignedRecipientMayAct: boolean;
  /** The owning domain, used in the refusal message and the audit record. */
  owner: string;
};

export type StaffAlertSubject = {
  alert_type?: unknown;
  team_code?: unknown;
  recipient_email?: unknown;
};

const FINANCE: StaffAlertAuthority = { permissions: ["payments.manage", "finance.manage"], assignedRecipientMayAct: false, owner: "Finance" };
const SALES: StaffAlertAuthority = { permissions: ["customers.manage"], assignedRecipientMayAct: true, owner: "Sales" };
const OPERATIONS: StaffAlertAuthority = { permissions: ["customers.manage", "providers.manage"], assignedRecipientMayAct: true, owner: "Operations" };
const PEOPLE: StaffAlertAuthority = { permissions: ["people.manage", "customers.manage"], assignedRecipientMayAct: true, owner: "People" };
/** No policy matched. Only a platform owner may act, and the refusal says why. */
const UNGOVERNED: StaffAlertAuthority = { permissions: [], assignedRecipientMayAct: false, owner: "no configured owner" };

/** Keyed by the alert_type values emitted in lib/staff-alert-center.ts. */
const BY_ALERT_TYPE: Record<string, StaffAlertAuthority> = {
  payment_failure: FINANCE,
  lead_sla_breach: SALES,
  lead_manager_escalation: SALES,
  lead_reassignment_due: SALES,
  case_first_response_overdue: OPERATIONS,
  case_manager_escalation: OPERATIONS,
  case_resolution_overdue: OPERATIONS,
  boarding_acceptance_timeout: OPERATIONS,
  rep_daily_closure_incomplete: PEOPLE,
};

/** Fallback for an alert whose type has no entry but whose owning team is known. */
const BY_TEAM: Record<string, StaffAlertAuthority> = {
  finance: FINANCE,
  sales: SALES,
  operations: OPERATIONS,
  marketing: SALES,
  people: PEOPLE,
};

const lower = (value: unknown) => String(value ?? "").trim().toLowerCase();

export function staffAlertAuthority(alert: StaffAlertSubject): StaffAlertAuthority {
  return BY_ALERT_TYPE[lower(alert.alert_type)] || BY_TEAM[lower(alert.team_code)] || UNGOVERNED;
}

export type StaffAlertActor = { email: string; permissions: string[] };

/**
 * Decides one acknowledge/resolve attempt. Returns a reason on refusal rather than throwing, so the
 * caller can write a denied audit record before turning it into a 403.
 */
export function authorizeStaffAlertAction(actor: StaffAlertActor, alert: StaffAlertSubject, action: "acknowledge" | "resolve") {
  const authority = staffAlertAuthority(alert);
  // Platform owners (founder, superuser, development preview) hold "*" and pass every policy.
  if (actor.permissions.includes("*")) return { allowed: true as const, authority, reason: "" };

  if (authority.permissions.some((permission) => hasPermission(actor.permissions, permission))) {
    return { allowed: true as const, authority, reason: "" };
  }

  const addressee = lower(alert.recipient_email);
  if (authority.assignedRecipientMayAct && addressee && addressee === lower(actor.email)) {
    return { allowed: true as const, authority, reason: "" };
  }

  const needed = authority.permissions.length ? authority.permissions.join(" or ") : "platform owner access";
  return {
    allowed: false as const,
    authority,
    reason: `${authority.owner} owns this alert. ${action === "resolve" ? "Resolving" : "Acknowledging"} it requires ${needed}.`,
  };
}
