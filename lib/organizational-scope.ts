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
};

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

export function isManagerScopedActor(actor: AuthenticatedActor) {
  return actor.roleCode === "manager" && !actor.developmentPreview && !actor.permissions.includes("*");
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
  if (!row || !cityId || !teamCode || !departmentCode) {
    throw authFailure("Manager organizational scope is not fully provisioned", 403);
  }
  return { employeeId: text(row.id), cityId, teamCode, departmentCode };
}

export function requireManagerDomain(scope: OrganizationalScope | null, input: { teams: readonly string[]; departments: readonly string[]; label: string }) {
  if (!scope) return;
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
