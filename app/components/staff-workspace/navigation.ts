import { hasPermission, type Permission } from "../../../lib/platform-security";

export type StaffActor = { name: string; email: string; roleCode: string; permissions: string[] };
export type StaffLink = { label: string; href: string; permission: Permission };
export type StaffGroup = { id: string; label: string; links: StaffLink[] };
/** Existing destinations only. Visibility is not a replacement for server authorization. */
export const STAFF_GROUPS: StaffGroup[] = [
  { id: "sales", label: "Sales & customers", links: [
    { label: "Customer 360", href: "/team/sales", permission: "customers.view" },
    { label: "Leads & CRM", href: "/crm", permission: "customers.view" },
    { label: "Daily revenue", href: "/team/daily-revenue", permission: "customers.view" },
    { label: "Customer reminders", href: "/team/customer-reminders", permission: "customers.view" },
    { label: "Inbox & AI", href: "/team/customer-experience", permission: "communications.manage" },
    { label: "Cases & recovery", href: "/team/cases", permission: "customers.view" },
    { label: "Subscriptions", href: "/team/subscriptions", permission: "customers.view" },
  ] },
  { id: "operations", label: "Bookings & operations", links: [
    { label: "Booking Command Center", href: "/team/operations/bookings", permission: "bookings.view" },
    { label: "Live calendar & delivery", href: "/team/operations", permission: "bookings.view" },
    { label: "Scheduling", href: "/team/scheduling", permission: "scheduling.view" },
    { label: "Meet & greet", href: "/team/meet-and-greet", permission: "bookings.manage" },
    { label: "Create a booking", href: "/assisted-booking", permission: "bookings.manage" },
  ] },
  { id: "people", label: "Partners & people", links: [
    { label: "People workspace", href: "/v2/team/people", permission: "people.view" },
    { label: "Attendance & leave", href: "/v2/team/people/time", permission: "people.view" },
    { label: "Employee onboarding", href: "/v2/team/people/onboarding", permission: "people.manage" },
    { label: "Provider onboarding", href: "/team/provider-onboarding", permission: "providers.manage" },
    { label: "Payroll", href: "/v2/team/people/payroll", permission: "payroll.view" },
    { label: "My employee workspace", href: "/v2/employee", permission: "self_service.view" },
    { label: "Incentives", href: "/v2/team/people/incentives", permission: "people.view" },
    { label: "Service incentives", href: "/v2/team/people/service-incentives", permission: "people.view" },
    { label: "Manager dashboard", href: "/v2/team/people/manager-dashboard", permission: "people.view" },
    { label: "People reports", href: "/v2/team/people/reports", permission: "reports.view" },
    { label: "People finance", href: "/v2/team/people/finance", permission: "finance.view" },
  ] },
  { id: "finance", label: "Finance & compliance", links: [
    { label: "Finance workspace", href: "/team/finance", permission: "finance.view" },
    { label: "Cash flow", href: "/team/finance/cash-flow", permission: "finance.view" },
    { label: "Contractor pay", href: "/team/finance/contractors", permission: "finance.view" },
    { label: "Escalation refunds", href: "/team/finance/escalation-refunds", permission: "finance.view" },
    { label: "Compliance", href: "/team/finance-compliance", permission: "finance.view" },
  ] },
  { id: "growth", label: "Growth & communications", links: [
    { label: "Marketing", href: "/team/marketing", permission: "marketing.view" },
    { label: "Voice operations", href: "/team/voice", permission: "communications.call" },
    { label: "WhatsApp workspace", href: "/team/whatsapp", permission: "communications.manage" },
    { label: "WhatsApp templates", href: "/team/whatsapp/templates", permission: "communications.manage" },
  ] },
  { id: "reports", label: "Reports & intelligence", links: [
    { label: "Analytics", href: "/team/analytics", permission: "reports.view" },
    { label: "Revenue mission", href: "/team/revenue-mission", permission: "reports.view" },
    { label: "Atlas intelligence", href: "/team/ai", permission: "reports.view" },
    { label: "Performance", href: "/v2/team/performance", permission: "performance.view" },
  ] },
  { id: "settings", label: "Settings & controls", links: [
    { label: "Founder & system controls", href: "/control", permission: "launch.view" },
    { label: "System integrations", href: "/control/integrations", permission: "settings.manage" },
    { label: "Lifecycle automation", href: "/team/lifecycle-reminders", permission: "settings.manage" },
    { label: "Subscription plans", href: "/team/subscription-plans", permission: "pricing.view" },
    { label: "Pricing & packages", href: "/team/catalogue", permission: "pricing.manage" },
  ] },
];

/** Aliases affect the active navigation label only; the URL is never rewritten. */
export function staffNavigationPath(path: string): string {
  if (path === "/booking-command-center" || path === "/v2/control-center") return "/team/operations/bookings";
  if (path === "/v2/crm") return "/crm";
  if (path === "/ops") return "/team";
  if (path === "/me") return "/v2/employee";
  if (path === "/team/people") return "/v2/team/people";
  if (path === "/team/people/onboarding") return "/v2/team/people/onboarding";
  if (path === "/team/people/time") return "/v2/team/people/time";
  if (path === "/team/people/finance") return "/v2/team/people/finance";
  if (path === "/team/people/reports") return "/v2/team/people/reports";
  if (path === "/team/people/provider-training") return "/v2/team/people/provider-training";
  if (path === "/team/people/payroll") return "/v2/team/people/payroll";
  if (path === "/team/people/incentives") return "/v2/team/people/incentives";
  if (path === "/team/people/service-incentives") return "/v2/team/people/service-incentives";
  if (path === "/team/people/manager-dashboard") return "/v2/team/people/manager-dashboard";
  if (path === "/team/performance") return "/v2/team/performance";
  return path;
}
export function visibleStaffGroups(permissions: string[], query = ""): StaffGroup[] {
  const needle = query.trim().toLocaleLowerCase();
  return STAFF_GROUPS.map(group => ({ ...group, links: group.links.filter(link =>
    hasPermission(permissions, link.permission) && (!needle || `${group.label} ${link.label} ${link.href}`.toLocaleLowerCase().includes(needle))
  ) })).filter(group => group.links.length > 0);
}
export function activeStaffLink(path: string): string | null {
  const current = staffNavigationPath(path);
  return STAFF_GROUPS.flatMap(group => group.links).filter(link => current === link.href || current.startsWith(`${link.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null;
}
