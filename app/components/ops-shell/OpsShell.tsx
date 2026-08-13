"use client";
import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./ops-shell.module.css";

/**
 * The Operations chrome every internal console renders inside: the same sidebar, brand and workspace
 * header as the admin surface, so a staff member moving between screens stays in one product instead
 * of landing on a differently-shaped page each time.
 *
 * The nav is a plain list of routes with the current one marked from the pathname - no counts are
 * shown unless a screen passes one, because an invented badge looks like a queue length and is
 * checked by nobody.
 */
export type OpsNavItem = { href: string; label: string; icon: string; badge?: number | null };

const NAV: OpsNavItem[] = [
  { href: "/team", label: "Overview", icon: "⌂" },
  { href: "/team/operations", label: "Operations", icon: "▦" },
  { href: "/team/scheduling", label: "Day board", icon: "▤" },
  { href: "/team/customer-experience", label: "CX queue", icon: "◉" },
  { href: "/team/cases", label: "Cases", icon: "◆" },
  { href: "/team/customer-reminders", label: "Reminders", icon: "◈" },
  { href: "/team/meet-and-greet", label: "Meet & greet", icon: "⌾" },
  { href: "/team/subscription-plans", label: "Subscriptions", icon: "▣" },
  { href: "/team/performance", label: "Performance", icon: "▲" },
  { href: "/team/marketing", label: "Marketing", icon: "◐" },
  { href: "/team/people", label: "People", icon: "☗" },
  { href: "/team/finance-compliance", label: "Finance", icon: "₹" },
  { href: "/team/analytics", label: "Analytics", icon: "◎" },
];

const FOOTER = [
  { href: "/team", label: "⌂ Team home" },
  { href: "/team/operations/bookings", label: "▤ Booking Command Center" },
  { href: "/control/integrations", label: "◎ System Integration Control" },
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
  const active = nav.reduce((best, item) => {
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
          {nav.map((item) => (
            <Link key={item.href} href={item.href} className={item.href === active ? styles.activeNav : undefined} aria-current={item.href === active ? "page" : undefined}>
              <i aria-hidden>{item.icon}</i>
              <span>{item.label}</span>
              {item.badge ? <b>{item.badge}</b> : null}
            </Link>
          ))}
        </nav>
        <div className={styles.sidebarFooter}>
          {FOOTER.map((item) => <Link key={item.href} href={item.href}>{item.label}</Link>)}
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
