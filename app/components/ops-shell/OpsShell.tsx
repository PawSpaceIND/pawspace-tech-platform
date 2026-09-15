"use client";
import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { hasPermission, type Permission } from "../../../lib/platform-security";
import { useStaffPermissions, visibleHubLinks } from "../hub-workspace-links";
import styles from "./ops-shell.module.css";

/**
 * The Operations chrome every internal console renders inside: the same sidebar, brand and workspace
 * header as the admin surface, so a staff member moving between screens stays in one product instead
 * of landing on a differently-shaped page each time.
 *
 * The nav is a permission-filtered list of routes with the current one marked from the pathname - no
 * counts are shown unless a screen passes one, because an invented badge looks like a queue length
 * and is checked by nobody.
 */
export type OpsNavItem = { href: string; label: string; icon: string; permission: Permission; badge?: number | null };

/**
 * The rail, and the permission each destination's own API enforces.
 *
 * This list used to carry no permission at all and rendered in full to every role, on every screen
 * the Operations chrome wraps. A finance operator was offered the CX queue, the day board, Cases and
 * Meet & greet; an auditor was offered all thirteen. None of those screens would load for them - the
 * gateway refuses the read - so the product was inviting people into a 403 and leaving them unable to
 * tell a missing permission from a broken page. That is the same defect
 * app/components/hub-workspace-links.tsx fixed one level down, and this is the same gate, reusing the
 * same filter rather than inventing a third copy of it.
 *
 * Every `permission` below is read off the destination's own route handler or its entry in
 * lib/api-gateway.ts, never chosen for convenience:
 *
 *   /team                     /api/team-overview             dashboard.view
 *   /team/operations          (hub page; no API of its own)  bookings.view  - see below
 *   /team/scheduling          /api/uat-scheduling GET        scheduling.manage
 *   /team/customer-experience /api/conversations             communications.manage
 *   /team/cases               /api/unified-cases             bookings.manage
 *   /team/customer-reminders  /api/customer-reminders GET    settings.manage (handler-enforced)
 *   /team/meet-and-greet      /api/meet-and-greet GET        bookings.manage
 *   /team/subscription-plans  /api/subscription-plans GET    pricing.view    (handler-enforced)
 *   /team/performance         /api/employee-performance      reports.view    (handler-enforced)
 *   /team/marketing           /api/marketing-control GET     marketing.view
 *   /team/people              /api/people-foundation GET     people.view     (handler-enforced)
 *   /team/finance-compliance  /api/statutory-compliance GET  finance.view
 *   /team/analytics           /api/company-analytics         reports.view
 *
 * Four of those routes fall through lib/api-gateway.ts to its `dashboard.view` catch-all and enforce
 * their real permission in the handler instead; the handler's is the one that actually refuses, so it
 * is the one recorded here.
 *
 * /team/operations is the only entry with no API of its own: it is a page of links. It takes
 * bookings.view, the weakest permission any workspace it offers requires (the Relocation and Funeral
 * coordination queues) - so a role that can open nothing under it is not sent there.
 */
const NAV: OpsNavItem[] = [
  { href: "/team", label: "Overview", icon: "⌂", permission: "dashboard.view" },
  { href: "/team/operations", label: "Operations", icon: "▦", permission: "bookings.view" },
  { href: "/team/scheduling", label: "Day board", icon: "▤", permission: "scheduling.manage" },
  { href: "/team/customer-experience", label: "CX queue", icon: "◉", permission: "communications.manage" },
  { href: "/team/cases", label: "Cases", icon: "◆", permission: "bookings.manage" },
  { href: "/team/customer-reminders", label: "Reminders", icon: "◈", permission: "settings.manage" },
  { href: "/team/meet-and-greet", label: "Meet & greet", icon: "⌾", permission: "bookings.manage" },
  { href: "/team/subscription-plans", label: "Subscriptions", icon: "▣", permission: "pricing.view" },
  { href: "/team/performance", label: "Performance", icon: "▲", permission: "reports.view" },
  { href: "/team/marketing", label: "Marketing", icon: "◐", permission: "marketing.view" },
  { href: "/team/people", label: "People", icon: "☗", permission: "people.view" },
  { href: "/team/finance-compliance", label: "Finance", icon: "₹", permission: "finance.view" },
  { href: "/team/analytics", label: "Analytics", icon: "◎", permission: "reports.view" },
];

/**
 * The same gate on the rail's footer, which had the same hole: /team/operations/bookings reads
 * /api/booking-command-center at bookings.manage and /control/integrations reads
 * /api/integration-readiness at launch.view, and both were offered to everyone.
 *
 * /mobile-app carries no permission deliberately. It is the CUSTOMER app, not a staff console, and
 * it is reachable by anyone; gating it on a staff permission would hide a public surface rather than
 * protect one. An entry with no permission is always shown, and that is the only such entry.
 */
const FOOTER: { href: string; label: string; permission?: Permission }[] = [
  { href: "/team", label: "⌂ Team home", permission: "dashboard.view" },
  { href: "/me", label: "◉ My workspace", permission: "self_service.view" },
  { href: "/team/operations/bookings", label: "▤ Booking Command Center", permission: "bookings.manage" },
  { href: "/control/integrations", label: "◎ System Integration Control", permission: "launch.view" },
  { href: "/mobile-app", label: "◉ Customer Mobile App" },
];

export interface OpsShellProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  nav?: OpsNavItem[];
  children: ReactNode;
}

export default function OpsShell({ eyebrow, title, description, actions, nav = NAV, children }: OpsShellProps) {
  const pathname = usePathname();
  // The same hook the hubs use, reading the same /api/team-overview actor. A failure resolves to no
  // permissions rather than to an error: the workspace still renders, and no rail entry is offered
  // that the actor has not been shown to hold.
  const access = useStaffPermissions();
  // Nothing is offered until the actor is known. A rail item shown and then withdrawn reads as a
  // permission that was just taken away, which is worse than a rail that fills in a moment later.
  const visible = access.loaded ? visibleHubLinks(access.permissions, nav) : [];
  const visibleFooter = access.loaded ? FOOTER.filter((item) => !item.permission || hasPermission(access.permissions, item.permission)) : [];
  // Computed from what is on screen: marking an entry current that the rail is not rendering would
  // point at a screen this role cannot open.
  const active = visible.reduce((best, item) => {
    if (!pathname?.startsWith(item.href)) return best;
    return !best || item.href.length > best.length ? item.href : best;
  }, "");

  return (
    <main className={styles.opsShell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/assets/pawspace-logo.jpeg" alt="PawSpace" />
          <span>Operations</span>
        </div>
        <nav aria-label="Operations">
          {visible.map((item) => (
            <Link key={item.href} href={item.href} className={item.href === active ? styles.activeNav : undefined} aria-current={item.href === active ? "page" : undefined}>
              <i aria-hidden>{item.icon}</i>
              <span>{item.label}</span>
              {item.badge ? <b>{item.badge}</b> : null}
            </Link>
          ))}
        </nav>
        <div className={styles.sidebarFooter}>
          {visibleFooter.map((item) => <Link key={item.href} href={item.href}>{item.label}</Link>)}
        </div>
      </aside>

      <section className={styles.workspace}>
        <header className={styles.header}>
          <div>
            {eyebrow ? <p>{eyebrow}</p> : null}
            <h1>{title}</h1>
            {description ? <p className={styles.lede}>{description}</p> : null}
          </div>
          {actions ? <div className={styles.headerActions}>{actions}</div> : null}
        </header>
        {children}
      </section>
    </main>
  );
}
