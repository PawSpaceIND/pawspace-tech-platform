"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./team-shell.module.css";
import PageHeader from "./PageHeader";

/**
 * The shared frame for a Team workspace page.
 *
 * The kit (Card, StatCard, Badge, Button, PageHeader, EmptyState) already existed, but most Team
 * pages never adopted it and hand-rolled their own inline styles instead — and a few, like
 * /team/revenue-mission, had no styling at all and rendered as raw browser-default text on a white
 * page. Anything built on this shell gets the same background, width, header, navigation and
 * section/table treatment as the rest of Team, so a new page cannot silently ship unstyled.
 */

export interface TeamNavLink { href: string; label: string; primary?: boolean }

export function TeamShell({ eyebrow, title, description, nav = [], status, children }: { eyebrow: ReactNode; title: ReactNode; description?: ReactNode; nav?: TeamNavLink[]; status?: ReactNode; children: ReactNode }) {
  return (
    <main className={styles.shell}>
      <div className={styles.inner}>
        <PageHeader
          eyebrow={eyebrow}
          title={title}
          description={description}
          actions={nav.length > 0 ? <nav className={styles.nav}>{nav.map((link) => <Link key={link.href} href={link.href} className={link.primary ? styles.navPrimary : styles.navLink}>{link.label}</Link>)}</nav> : undefined}
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
