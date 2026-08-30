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
          <Link href="/partner-mobile" className={styles.primary}>
            Open Partner Mobile App →
          </Link>
          <Link href="/partner/onboarding" className={styles.secondary}>
            Open canonical provider onboarding →
          </Link>
        </div>
      </header>

      <section className={styles.work}>
        <small>IDENTITY-SCOPED PROVIDER WORK</small>
        <h2>Canonical Grooming assignments</h2>
        <p>
          Work orders resolve from the verified provider identity session. A provider cannot select another provider ID in the browser.
        </p>
        <CanonicalGroomingJobs />
      </section>
    </main>
  );
}
