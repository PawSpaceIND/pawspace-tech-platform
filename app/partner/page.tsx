import Link from "next/link";
import CanonicalGroomingJobs from "../partner-app/canonical-grooming-jobs";
import styles from "./partner-hub.module.css";

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
          The job feed is the common entry point. Service actions continue in the existing governed workspaces below; no parallel lifecycle or prototype action is introduced here.
        </p>
        <div className={styles.actions}>
          <Link href="/partner/jobs" className={styles.primary}>All assigned jobs</Link>
          <Link href="/partner-app" className={styles.secondary}>Grooming</Link>
          <Link href="/trainer" className={styles.secondary}>Training</Link>
          <Link href="/walker" className={styles.secondary}>Dog Walking</Link>
          <Link href="/driver" className={styles.secondary}>Pet Taxi</Link>
          <Link href="/host" className={styles.secondary}>Boarding</Link>
          <Link href="/sitter" className={styles.secondary}>Pet Sitting</Link>
        </div>
      </section>

      <section className={styles.work}>
        <small>IDENTITY-SCOPED GROOMING WORK</small>
        <h2>Canonical Grooming assignments</h2>
        <p>
          Work orders resolve from the verified provider identity session. A provider cannot select another provider ID in the browser.
        </p>
        <CanonicalGroomingJobs />
      </section>
    </main>
  );
}
