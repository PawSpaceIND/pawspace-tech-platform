"use client";
import type { ReactNode } from "react";
import styles from "./ui.module.css";

export interface PageHeaderProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export default function PageHeader({ eyebrow, title, description, actions, className }: PageHeaderProps) {
  return (
    <header className={[styles.pageHeader, className].filter(Boolean).join(" ")}>
      <div>
        {eyebrow && <p className={styles.pageHeaderEyebrow}>{eyebrow}</p>}
        <h1 className={styles.pageHeaderTitle}>{title}</h1>
        {description && <p className={styles.pageHeaderDescription}>{description}</p>}
      </div>
      {actions && <div className={styles.pageHeaderActions}>{actions}</div>}
    </header>
  );
}
