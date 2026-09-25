"use client";

import type { ReactNode } from "react";
import StaffWorkspace from "./StaffWorkspace";
import consoleStyles from "./staff-console.module.css";
import styles from "./staff-module.module.css";

/** Standalone staff pages retain their own requests, state and actions unchanged. */
export default function StaffModule({ children }: { children: ReactNode }) {
  return <StaffWorkspace><div data-staff-module="true" className={`${consoleStyles.console} ${styles.module}`}>{children}</div></StaffWorkspace>;
}
