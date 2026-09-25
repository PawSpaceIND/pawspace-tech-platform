import type { ReactNode } from "react";
import Link from "next/link";
import styles from "./partner-presentation.module.css";

/** Presentation only. The existing children still own identity, jobs and all actions. */
export default function PartnerModule({ children }: { children: ReactNode }) {
  return <div className={styles.frame} data-partner-presentation="true">
    <a className={styles.skip} href="#partner-workspace-content">Skip to partner workspace</a>
    <header className={styles.topbar}>
      <Link href="/partner" prefetch={false} className={styles.logo} aria-label="PawSpace Partner home">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/pawspace-horizontal.png" width="315" height="89" alt="PawSpace" />
      </Link>
      <nav aria-label="Partner workspaces" className={styles.navigation}>
        <Link href="/partner/jobs" prefetch={false}>Assigned jobs</Link>
        <Link href="/partner/workspace" prefetch={false}>My workspace</Link>
        <Link href="/partner/onboarding" prefetch={false}>Onboarding</Link>
      </nav>
    </header>
    <div id="partner-workspace-content" className={styles.content} tabIndex={-1}>{children}</div>
  </div>;
}
