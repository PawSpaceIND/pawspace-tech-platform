import Link from "next/link";
import { PageHeader } from "../../components/ui";
import styles from "../team-console.module.css";

const QUEUES = [
  { href: "/team/operations/bookings", title: "Booking Command Center", body: "All canonical bookings, providers, payments, tickets and operational events." },
  { href: "/team/operations/boarding", title: "Boarding exception queue", body: "Host recovery, care incidents, finance review, proof/media blockers and settlement readiness." },
  { href: "/team/operations/sitting", title: "Sitting exception queue", body: "Sitter recovery, care incidents, finance review, proof/media blockers and service-timing exceptions." },
  { href: "/team/operations/walking", title: "Walking exception queue", body: "Walker recovery, route evidence, safety incidents, completed-payment dues and settlement blockers." },
];

export default function TeamOperations() {
  return <main className={styles.shell}>
    <PageHeader
      eyebrow="PAWSPACE TEAM · OPERATIONS"
      title="Operations control"
      description="Open the canonical cross-service Booking Command Center, or a service-specific exception and recovery queue."
    />
    <nav className={styles.nav} aria-label="Team workspaces">
      <Link href="/team">← Team OS</Link><Link href="/team/cases">Cases</Link><Link href="/team/customer-experience">CX queue</Link>
    </nav>

    <section className={styles.cardGrid}>
      {QUEUES.map((queue) => <Link key={queue.href} href={queue.href} className={styles.linkCard}>
        <h2>{queue.title}</h2>
        <p>{queue.body}</p>
        <span className={styles.linkCue}>Open →</span>
      </Link>)}
    </section>

    <footer className={styles.footnote}>UAT controlled. Live integrations and production credentials remain disabled.</footer>
  </main>;
}
