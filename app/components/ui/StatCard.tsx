"use client";
import type { ReactNode } from "react";
import styles from "./ui.module.css";

export interface StatCardProps {
  label: string;
  value: ReactNode;
  meta?: ReactNode;
  trend?: "up" | "down" | "none";
  className?: string;
}

export default function StatCard({ label, value, meta, trend = "none", className }: StatCardProps) {
  const trendClass = trend === "up" ? styles.statTrendUp : trend === "down" ? styles.statTrendDown : "";
  return (
    <div className={[styles.statCard, className].filter(Boolean).join(" ")}>
      <span className={styles.statLabel}>{label}</span>
      <strong className={styles.statValue}>{value}</strong>
      {meta && <span className={[styles.statMeta, trendClass].filter(Boolean).join(" ")}>{meta}</span>}
    </div>
  );
}
