"use client";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./ui.module.css";

type Variant = "primary" | "accent" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const variantClass: Record<Variant, string> = {
  primary: styles.btnPrimary,
  accent: styles.btnAccent,
  secondary: styles.btnSecondary,
  ghost: styles.btnGhost,
  danger: styles.btnDanger,
};
const sizeClass: Record<Size, string> = { sm: styles.sizeSm, md: styles.sizeMd, lg: styles.sizeLg };

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
}

export default function Button({ variant = "primary", size = "md", className, children, ...rest }: ButtonProps) {
  const combined = [styles.btn, variantClass[variant], sizeClass[size], className].filter(Boolean).join(" ");
  return <button className={combined} {...rest}>{children}</button>;
}
