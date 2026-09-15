import Link from "next/link";
import { ProviderHubWorkspaceLinks, type HubWorkspaceLink } from "../components/hub-workspace-links";
import styles from "./partner-hub.module.css";

/**
 * Provider workspaces the hub never offered. All three existed and worked; none was linked from
 * anywhere in app/, lib/ or worker/, so a partner could reach them only by typing the URL:
 *
 *  - /partner/rates    self-pricing for Boarding and Pet Sitting, above the PawSpace floor price.
 *  - /partner/funeral  the provider-scoped funeral coordination queue and its milestones.
 *  - /trainer          the Dog Training field workspace (sessions, evidence, earnings). Its two
 *                      siblings are linked - /walker from /walking and /driver from /taxi - and it
 *                      is the one that was not.
 *
 * The gate is the verified provider identity session, not a staff account: /api/team-overview is
 * dashboard.view and refuses a provider, so these are filtered on the permissions the session
 * itself carries. self_service.view for rates (lib/session-api-gateway.ts scopes
 * /api/provider-service-rates to it) and bookings.view for the two booking-backed workspaces.
 */
export const partnerWorkspaceLinks: HubWorkspaceLink[] = [
  { href: "/trainer", label: "Dog Training workspace", detail: "Today's sessions, attendance and homework, governed session evidence and your training earnings.", permission: "bookings.view" },
  { href: "/partner/funeral", label: "Funeral & memorial coordination", detail: "Your assigned urgent requests: pickup coordination, milestones and case closure.", permission: "bookings.view" },
  { href: "/partner/rates", label: "Your Boarding & Sitting rates", detail: "Set your own price per package, at or above the PawSpace minimum for your city and zone.", permission: "self_service.view" },
];

export default function PartnerUatHub() {
  return (
    <main className={styles.hub}>
      <header className={styles.hero}>
        <small>PAWSPACE PARTNER · CANONICAL UAT</small>
        <h1>Partner UAT hub</h1>
        <p>
          Provider onboarding and assigned work below use canonical server-owned state. This surface does not infer verification, approval, activation, marketplace availability, or booking eligibility from prototype data.
        </p>
        <p className={styles.status}>
          <strong>PRODUCTION READY = FALSE.</strong> Marketplace live: No · Order eligible: No · Live money: No.
        </p>
        <div className={styles.actions}>
          <Link href="/partner/jobs" className={styles.primary}>
            Open all assigned jobs →
          </Link>
          <Link href="/partner/onboarding" className={styles.secondary}>
            Open canonical provider onboarding →
          </Link>
        </div>
      </header>

      <section className={styles.work}>
        <small>CROSS-SERVICE PARTNER WORKSPACES</small>
        <h2>Continue in the workflow for your assigned service</h2>
        <p>
          The assigned-job feed is the common entry point. It carries the canonical booking context into workspaces that require a booking ID and keeps provider-scoped work on its existing governed surfaces.
        </p>
        <div className={styles.actions}>
          <Link href="/partner/jobs" className={styles.primary}>All assigned jobs</Link>
        </div>
      </section>

      <section className={styles.work}>
        <small>IDENTITY-SCOPED GROOMING WORK</small>
        <h2>Canonical Grooming assignments</h2>
        <p>
          Work orders resolve from the verified provider identity session. A provider cannot select another provider ID in the browser.
        </p>
        <Link href="/partner-app" className={styles.primary}>Open active job, checklists &amp; tracking →</Link>
      </section>

      <ProviderHubWorkspaceLinks
        heading="Your other provider workspaces"
        note="Shown from your verified provider session. A workspace your session cannot open is not listed."
        links={partnerWorkspaceLinks}
      />
    </main>
  );
}
