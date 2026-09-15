"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./team-shell.module.css";
import PageHeader from "./PageHeader";
import { useStaffPermissions } from "../hub-workspace-links";
import { hasPermission, type Permission } from "../../../lib/platform-security";

/**
 * The shared frame for a Team workspace page.
 *
 * The kit (Card, StatCard, Badge, Button, PageHeader, EmptyState) already existed, but most Team
 * pages never adopted it and hand-rolled their own inline styles instead — and a few, like
 * /team/revenue-mission, had no styling at all and rendered as raw browser-default text on a white
 * page. Anything built on this shell gets the same background, width, header, navigation and
 * section/table treatment as the rest of Team, so a new page cannot silently ship unstyled.
 */

/**
 * `permission` is the permission the DESTINATION demands to load, read off that route's own API -
 * the same rule app/components/hub-workspace-links.tsx states for a hub tile. An entry that names
 * one is hidden from an actor who does not hold it, because offering a link whose screen answers
 * "Permission denied" is worse than not offering it: the operator cannot tell a missing permission
 * from a broken page. /team/revenue-mission, /team/voice/ai-test and /team/ai/analytics load on
 * reports.view, settings.manage and dashboard.view respectively, and each offered a nav sibling
 * behind a permission its own visitors need not hold - finance and auditor could open Revenue
 * Mission Control and were then refused by both of the links it showed them.
 *
 * An entry with no `permission` is not gated at all, so a caller that has not opted in is unchanged.
 */
export interface TeamNavLink { href: string; label: string; primary?: boolean; permission?: Permission }

export function TeamShell({ eyebrow, title, description, nav = [], status, children }: { eyebrow: ReactNode; title: ReactNode; description?: ReactNode; nav?: TeamNavLink[]; status?: ReactNode; children: ReactNode }) {
  /*
   * The gate lives here rather than in a nested nav component so that it is the SHELL's own effect:
   * a child's effect is not what decides whether a link is offered, and a test that mounts the shell
   * can then see the real answer instead of an empty nav. Until the actor has loaded, a gated entry
   * is not offered - a link shown and then withdrawn reads as a permission just taken away.
   */
  const { permissions, loaded } = useStaffPermissions();
  const visibleNav = nav.filter((link) => !link.permission || (loaded && hasPermission(permissions, link.permission)));
  return (
    <main className={styles.shell}>
      <div className={styles.inner}>
        <PageHeader
          eyebrow={eyebrow}
          title={title}
          description={description}
          actions={visibleNav.length > 0 ? <nav className={styles.nav}>{visibleNav.map((link) => <Link key={link.href} href={link.href} className={link.primary ? styles.navPrimary : styles.navLink}>{link.label}</Link>)}</nav> : undefined}
        />
        {status}
        {children}
      </div>
    </main>
  );
}

/** A banner that is never silently absent: an error always shows, and always says what failed. */
export function TeamAlert({ tone = "error", children }: { tone?: "error" | "success" | "info"; children: ReactNode }) {
  if (!children) return null;
  return <p role={tone === "error" ? "alert" : "status"} className={[styles.alert, tone === "success" ? styles.alertSuccess : tone === "info" ? styles.alertInfo : styles.alertError].join(" ")}>{children}</p>;
}

export function TeamSection({ title, note, actions, children }: { title?: ReactNode; note?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className={styles.section}>
      {(title || actions) && <div className={styles.sectionHead}><div>{title && <h2 className={styles.sectionTitle}>{title}</h2>}{note && <p className={styles.sectionNote}>{note}</p>}</div>{actions}</div>}
      {children}
    </section>
  );
}

export function TeamStatGrid({ children }: { children: ReactNode }) {
  return <div className={styles.statGrid}>{children}</div>;
}

/**
 * A table that scrolls inside its own box rather than pushing the page sideways, and that states
 * when it is empty instead of collapsing into nothing.
 */
export function TeamTable({ head, rows, empty = "Nothing recorded yet." }: { head: ReactNode[]; rows: ReactNode[][]; empty?: ReactNode }) {
  if (rows.length === 0) return <p className={styles.tableEmpty}>{empty}</p>;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead><tr>{head.map((cell, index) => <th key={index}>{cell}</th>)}</tr></thead>
        <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, index) => <td key={index} className={index === 0 ? styles.tableKey : undefined}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

/** A labelled figure inside a section — for the many "Booked / Collected / Refunded" style rows. */
export function TeamFigures({ items }: { items: Array<{ label: ReactNode; value: ReactNode; tone?: "default" | "good" | "bad" }> }) {
  return <dl className={styles.figures}>{items.map((item, index) => (
    <div key={index}>
      <dt>{item.label}</dt>
      <dd className={item.tone === "good" ? styles.figureGood : item.tone === "bad" ? styles.figureBad : undefined}>{item.value}</dd>
    </div>
  ))}</dl>;
}
