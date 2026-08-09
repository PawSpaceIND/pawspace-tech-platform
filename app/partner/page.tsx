import Link from "next/link";
import CanonicalGroomingJobs from "../partner-app/canonical-grooming-jobs";

export default function PartnerUatHub() {
  return (
    <main style={{ padding: 24, maxWidth: 1200, margin: "0 auto", fontFamily: "system-ui" }}>
      <header>
        <small>PAWSPACE PARTNER · CANONICAL UAT</small>
        <h1>Partner UAT hub</h1>
        <p>
          Provider onboarding and assigned work below use canonical server-owned state. This surface does not infer verification, approval, activation, marketplace availability, or booking eligibility from prototype data.
        </p>
        <p>
          <strong>PRODUCTION READY = FALSE.</strong> Marketplace live: No · Order eligible: No · Live money: No.
        </p>
        <Link href="/partner/onboarding">Open canonical provider onboarding →</Link>
      </header>

      <section style={{ marginTop: 28 }}>
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
