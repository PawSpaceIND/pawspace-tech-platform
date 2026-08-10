"use client";
import type { HTMLAttributes, ReactNode } from "react";
import styles from "./ui.module.css";

type Tone = "success" | "warning" | "danger" | "info" | "neutral";

const toneClass: Record<Tone, string> = {
  success: styles.badgeSuccess,
  warning: styles.badgeWarning,
  danger: styles.badgeDanger,
  info: styles.badgeInfo,
  neutral: styles.badgeNeutral,
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  dot?: boolean;
  children: ReactNode;
}

export default function Badge({ tone = "neutral", dot = false, className, children, ...rest }: BadgeProps) {
  const combined = [styles.badge, toneClass[tone], className].filter(Boolean).join(" ");
  return <span className={combined} {...rest}>{dot && <i className={styles.badgeDot} />}{children}</span>;
}
