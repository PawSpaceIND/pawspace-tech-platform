"use client";

import type { ReactNode } from "react";
import styles from "./report-visuals.module.css";

export const reportDate = (value?: number) => value != null && Number.isFinite(value)
  ? new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(value)
  : "Date unavailable";

export function statusCounts(rows: { status?: unknown }[]) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const label = String(row.status || "Unspecified").replaceAll("_", " ");
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts].map(([label, value]) => ({ label, value }));
}

export function VisualGrid({ children }: { children: ReactNode }) {
  return <div className={styles.grid}>{children}</div>;
}

/** Independent magnitudes on a common scale, never a stacked claim about overlapping counts. */
export function MetricBars({ title, note, items, format = value => value.toLocaleString("en-IN") }: {
  title: string; note?: string;
  items: { label: string; value: number | null | undefined; tone?: "warning" | "gold" }[];
  format?: (value: number) => string;
}) {
  const maximum = Math.max(1, ...items.map(item => Number.isFinite(item.value) ? Math.abs(item.value!) : 0));
  return <section className={styles.card} aria-label={title}>
    <h3>{title}</h3>{note && <p className={styles.note}>{note}</p>}
    {items.length === 0 ? <p className={styles.note}>No records in this report.</p> : <dl className={styles.bars}>{items.map((item, index) => {
      const valid = item.value != null && Number.isFinite(item.value);
      return <div key={`${item.label}-${index}`}><div className={styles.label}><dt>{item.label}</dt><dd>{valid ? format(item.value!) : "Unavailable"}</dd></div>
        <div className={styles.track} aria-hidden="true"><div className={`${styles.fill} ${item.value! < 0 || item.tone === "warning" ? styles.warning : item.tone === "gold" ? styles.gold : ""}`} style={{ width: `${valid ? Math.abs(item.value!) / maximum * 100 : 0}%` }} /></div>
      </div>;
    })}</dl>}
    {items.some(item => (item.value ?? 0) < 0) && <p className={styles.note}>Bar lengths show magnitude; negative amounts retain their minus sign.</p>}
  </section>;
}

export function TargetProgress({ percent, title, note }: { percent: number | null; title: string; note?: string }) {
  const valid = percent != null && Number.isFinite(percent);
  const shown = valid ? Math.max(0, Math.min(100, percent)) : 0;
  return <section className={`${styles.card} ${styles.progress}`} aria-label={title}>
    <div className={styles.ring}>
      <svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="50" className={styles.ringTrack} /><circle cx="60" cy="60" r="50" className={styles.ringValue} pathLength="100" strokeDasharray={`${shown} 100`} transform="rotate(-90 60 60)" /></svg>
      <strong>{valid ? `${percent.toLocaleString("en-IN", { maximumFractionDigits: 1 })}%` : "—"}</strong>
    </div><div><h3>{title}</h3>{note && <p className={styles.note}>{note}</p>}</div>
  </section>;
}
