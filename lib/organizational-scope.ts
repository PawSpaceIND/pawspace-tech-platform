import type { AuthenticatedActor } from "./server-auth";
import { authFailure } from "./server-auth";
import { ensurePeopleTables } from "./people-foundation";

type Db = D1Database;
type Row = Record<string, unknown>;

export type OrganizationalScope = {
  cityId: string;
  teamCode: string;
  departmentCode: string;
  employeeId: string;
  /*
   * Present and true ONLY on the degraded scope below. Absent means "this placement was read from a
   * current employment version", so every scope built anywhere else keeps the full domain check.
   */
  unprovisioned?: true;
  /* Set with unprovisioned: the sentence a surface shows instead of silently rendering an empty list. */
  notice?: string;
};

/*
 * WHY AN UNPROVISIONED MANAGER IS DEGRADED AND NOT REFUSED.
 *
 * This resolver used to throw 403 "Manager organizational scope is not fully provisioned" whenever a
 * manager had no current employment version carrying location + team + cost centre. On this
 * deployment NO manager has one - not a manager created through the product's own user-management
 * API (app/api/platform-governance create_user writes app_users only; org placement is People's
 * data, written by lib/people-foundation upsertEmployee + addEmploymentVersion), and not
 * jyoti.manager39@tkpetcare.in, the "Jyoti Manager" identity /staging-login advertises as a
 * one-click sign-in. Every manager was refused from CRM, People and the Booking Command Center.
 *
 * The throw conflated two different answers: "you may not see this" and "we cannot tell what you may
 * see". Refusing the second as if it were the first makes the role unusable and gives the operator
 * no idea what to do about it.
 *
 * The fix keeps the security property and drops the outage. An unprovisioned manager resolves to a
 * scope whose city, team and cost centre are all empty. That is NOT null - null means unrestricted,
 * which is the one outcome this file exists to prevent - and every consumer already filters on these
 * three values, so an empty scope matches only work that carries no placement of its own:
 *   - lib/crm-contact-list.ts     equality on ''/''/'' plus the unclaimed branch -> unclaimed leads only
 *   - lib/people-foundation.ts    location/team/cost-centre all '' -> unplaced staff only
 *   - app/api/booking-command-center  lower(b.city_id)='' -> no bookings
 * So the manager gets a working screen showing exactly the work nobody has been placed over, plus
 * `notice`, which names what is missing and who records it. Nothing that belongs to another city,
 * team or cost centre becomes visible.
 *
 * Provisioning was the other candidate fix and is the wrong one on its own: it cannot repair the
 * managers that already exist, and user management has no organizational placement to record, so it
 * would have to invent a city and a cost centre for a new manager - handing out a data scope nobody
 * chose, which is worse than refusing. Placement stays People's to write; this file stops treating
 * its absence as a denial.
 */
export const UNPROVISIONED_MANAGER_NOTICE =
  "Manager organizational scope is not fully provisioned: no current employment record gives your account a location, team and cost centre, so only work that has not been assigned to any team is shown. Ask People Ops to record your employment details in Team → People.";

export function unprovisionedManagerScope(): OrganizationalScope {
  return { employeeId: "", cityId: "", teamCode: "", departmentCode: "", unprovisioned: true, notice: UNPROVISIONED_MANAGER_NOTICE };
}

/** The value a route puts in its `organizationalScope` field, for an actor that has no scope at all. */
export function organizationalScopeReport(scope: OrganizationalScope | null) {
  return scope ?? "global";
}

const text = (value: unknown) => String(value ?? "").trim();
const normalise = (value: unknown) => text(value).toLowerCase().replace(/_/g, "-");
const normaliseCity = (value: unknown) => {
  const code = normalise(value);
  if (["bangalore", "bengaluru", "blr"].includes(code)) return "blr";
  if (["hyderabad", "hyd"].includes(code)) return "hyd";
  if (["mumbai", "bom", "mum"].includes(code)) return "mum";
  if (["pune", "pnq"].includes(code)) return "pnq";
  if (["chennai", "maa", "chn"].includes(code)) return "maa";
  return code;
};

/*
 * A null scope means NO domain restriction (see requireManagerDomain), so whether an actor is
 * recognised as manager-scoped decides whether the restriction applies at all. Matching roleCode
 * with a case-sensitive === made that hinge on the exact spelling stored in app_users.role_code:
 * a row seeded as "Manager" would silently skip the domain check entirely. Only "manager" exists
 * in the catalogue today, so this is hardening rather than a live hole - but it is the same shape
 * as the AI kill switch that was engaged and did nothing, and a security control that quietly
 * stops applying is the worst kind. [D31-W10]
 */
export function isManagerScopedActor(actor: AuthenticatedActor) {
  return text(actor.roleCode).toLowerCase() === "manager" && !actor.developmentPreview && !actor.permissions.includes("*");
}

export async function resolveManagerOrganizationalScope(db: Db, actor: AuthenticatedActor): Promise<OrganizationalScope | null> {
  if (!isManagerScopedActor(actor)) return null;
  await ensurePeopleTables(db);
  const row = await db.prepare(`SELECT e.id,v.location_code,v.team_code,v.cost_centre_code
    FROM employees e
    JOIN employee_employment_versions v ON v.employee_id=e.id AND v.effective_until IS NULL
    WHERE e.employment_status='active' AND lower(COALESCE(e.user_email,e.work_email))=?
    ORDER BY v.version DESC LIMIT 1`).bind(actor.email.toLowerCase()).first<Row>().catch(() => null);
  const cityId = normaliseCity(row?.location_code);
  const teamCode = normalise(row?.team_code);
  const departmentCode = normalise(row?.cost_centre_code);
  if (!row || !cityId || !teamCode || !departmentCode) return unprovisionedManagerScope();
  return { employeeId: text(row.id), cityId, teamCode, departmentCode };
}

export function requireManagerDomain(scope: OrganizationalScope | null, input: { teams: readonly string[]; departments: readonly string[]; label: string }) {
  if (!scope) return;
  /*
   * An unprovisioned scope has no team and no cost centre, so it is not in ANY domain - asserting
   * membership would turn every hub into the 403 this degradation exists to remove, and would say
   * "outside your organizational scope", which is false: the scope is unknown, not different. The
   * data filter has already reduced this actor to unplaced work in every consumer (see the comment
   * on unprovisionedManagerScope), so there is nothing here for the domain check to protect.
   * Checked against `=== true` so a scope literal that predates this field still gets the check.
   */
  if (scope.unprovisioned === true) return;
  const teams = new Set(input.teams.map(normalise));
  const departments = new Set(input.departments.map(normalise));
  if (!teams.has(normalise(scope.teamCode)) || !departments.has(normalise(scope.departmentCode))) {
    throw authFailure(`${input.label} is outside the manager's organizational scope`, 403);
  }
}

export const CRM_MANAGER_DOMAIN = {
  teams: ["sales", "crm", "customer-experience", "cx"],
  departments: ["cc-sales", "sales", "cc-crm", "crm", "cc-customer-experience", "customer-experience", "cx"],
  label: "CRM",
} as const;

export const OPERATIONS_MANAGER_DOMAIN = {
  teams: ["operations", "ops", "service-delivery"],
  departments: ["cc-operations", "operations", "cc-ops", "ops", "cc-service-delivery", "service-delivery"],
  label: "Booking Command Center",
} as const;
