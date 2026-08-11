import Link from "next/link";
import styles from "./team.module.css";

const workspaces = [
  { group: "Sales", title: "Revenue & CRM", detail: "Daily Revenue 100, leads, RNR, renewals, cross-sell, incentives and leaderboard.", href: "/team/sales", metric: "100 actions today", tone: "purple" },
  { group: "Sales", title: "Customer reminders", detail: "Grooming rebooking cadence, subscription unused-session prompts and renewal reminders - real, governed, queued into the outbox automatically.", href: "/team/customer-reminders", metric: "Auto every 5 min", tone: "purple" },
  { group: "Operations", title: "Bookings & delivery", detail: "Live bookings, assignments, delays, partner work orders, completion evidence and escalations.", href: "/team/operations", metric: "18 bookings today", tone: "orange" },
  { group: "Customer experience", title: "Tickets & recovery", detail: "Customer 360, complaints, refund cases, RNR compliance, SLA and resolution evidence.", href: "/team/customer-experience", metric: "3 need attention", tone: "rose" },
  { group: "Finance", title: "Accounts & collections", detail: "Collections, payouts, refunds, reconciliation and mandatory day closure.", href: "/team/finance", metric: "Day close pending", tone: "green" },
  { group: "People", title: "HR & performance", detail: "Employees, attendance, payroll, targets, incentives and team achievement.", href: "/team/people", metric: "8 active partners", tone: "blue" },
  { group: "Marketing", title: "Segments & campaigns", detail: "Consent-safe audiences, WATI and SMS queues, promotions and campaign performance.", href: "/team/marketing", metric: "Live delivery locked", tone: "gold" },
] as const;

export default function TeamHome() {
  return (
    <main className={styles.shell}>
      <header className={styles.topbar}>
        <Link href="/" className={styles.brand}><b>paw</b>space <span>TEAM</span></Link>
        <nav aria-label="PawSpace experiences"><Link href="/">Customer</Link><Link href="/partner">Partner</Link><Link className={styles.active} href="/team">Team</Link><Link href="/control">Control</Link></nav>
        <div className={styles.user}><span>KP</span><div><b>Karthik</b><small>Super admin</small></div></div>
      </header>
      <section className={styles.hero}>
        <div><p>ONE TEAM WORKSPACE</p><h1>Good morning, Karthik.</h1><span>Sales, CX, Operations, Finance, HR and Marketing now work from one front door. Your role controls what you can open.</span></div>
        <Link href="/team/operations/bookings">Open Booking Command Center <b>→</b></Link>
      </section>
      <section className={styles.commandStrip} aria-label="Today at PawSpace">
        <article><span>Revenue actions</span><b>100</b><small>ranked and assigned</small></article><article><span>First-response SLA</span><b>10 min</b><small>manager alert at 30 min</small></article><article><span>Open escalations</span><b>3</b><small>1 requires action now</small></article><article><span>7 PM command pack</span><b>Ready</b><small>daily, weekly and monthly</small></article>
      </section>
      <section className={styles.workspaceSection}>
        <div className={styles.sectionHead}><div><p>ROLE-BASED WORKSPACES</p><h2>Choose what you need to run.</h2></div><span>6 teams · 1 customer record · 1 audit trail</span></div>
        <div className={styles.grid}>{workspaces.map((workspace) => <Link href={workspace.href} className={`${styles.card} ${styles[workspace.tone]}`} key={workspace.group}><div><span>{workspace.group}</span><i aria-hidden="true">↗</i></div><h3>{workspace.title}</h3><p>{workspace.detail}</p><footer><b>{workspace.metric}</b><span>Open workspace →</span></footer></Link>)}</div>
      </section>
      <footer className={styles.footer}><div><i></i><span>UAT workspace · sandbox payments and queued communications</span></div><Link href="/control">Founder & system controls →</Link></footer>
    </main>
  );
}
