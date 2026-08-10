"use client";
import type { HTMLAttributes, ReactNode } from "react";
import styles from "./ui.module.css";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padded?: boolean;
  elevated?: boolean;
  interactive?: boolean;
  children: ReactNode;
}

export default function Card({ padded = true, elevated = false, interactive = false, className, children, ...rest }: CardProps) {
  const combined = [
    styles.card,
    padded ? styles.cardPadded : "",
    elevated ? styles.cardElevated : "",
    interactive ? styles.cardInteractive : "",
    className,
  ].filter(Boolean).join(" ");
  return <div className={combined} {...rest}>{children}</div>;
}
