"use client";
import type { ReactNode } from "react";
import styles from "./ui.module.css";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export default function EmptyState({ icon = "🐾", title, body, action, className }: EmptyStateProps) {
  return (
    <div className={[styles.emptyState, className].filter(Boolean).join(" ")}>
      <span className={styles.emptyStateIcon}>{icon}</span>
      <p className={styles.emptyStateTitle}>{title}</p>
      {body && <p className={styles.emptyStateBody}>{body}</p>}
      {action}
    </div>
  );
}
