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
    { label: "People workspace", href: "/team/people", permission: "people.view" },
    { label: "Provider onboarding", href: "/team/provider-onboarding", permission: "providers.manage" },
    { label: "Payroll", href: "/team/people/payroll", permission: "payroll.view" },
    { label: "My employee workspace", href: "/me", permission: "self_service.view" },
  ] },
  { id: "finance", label: "Finance & compliance", links: [
    { label: "Finance workspace", href: "/team/finance", permission: "finance.view" },
    { label: "Cash flow", href: "/team/finance/cash-flow", permission: "finance.view" },
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
    { label: "Performance", href: "/team/performance", permission: "performance.view" },
  ] },
  { id: "settings", label: "Settings & controls", links: [
    { label: "Founder & system controls", href: "/control", permission: "launch.view" },
    { label: "System integrations", href: "/control/integrations", permission: "settings.manage" },
    { label: "Lifecycle automation", href: "/team/lifecycle-reminders", permission: "settings.manage" },
    { label: "Subscription plans", href: "/team/subscription-plans", permission: "pricing.view" },
    { label: "Catalogue & services", href: "/team/catalogue", permission: "pricing.manage" },
  ] },
];

/** Aliases affect the active navigation label only; the URL is never rewritten. */
export function staffNavigationPath(path: string): string {
  if (path === "/booking-command-center" || path === "/v2/control-center") return "/team/operations/bookings";
  if (path === "/v2/crm") return "/crm";
  if (path === "/ops") return "/team";
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
