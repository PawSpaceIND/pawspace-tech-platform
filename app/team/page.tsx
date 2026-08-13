"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import styles from "./team.module.css";
import TestSyncPanel from "../components/test-sync-panel";

type Overview = {
  actor: { name: string; email: string; roleCode: string };
  today: string;
  commandStrip: { revenueActions: number | null; firstResponseMinutes: number | null; managerAlertMinutes: number | null; openEscalations: number | null; openTickets: number | null; commandPackReports: number | null };
  workspaces: { bookingsToday: number | null; ticketsNeedAttention: number | null; dayCloseStatus: string | null; activeEmployees: number | null; aiHandoffsWaiting: number | null; aiTurnsToday: number | null; aiRolloutStage: string | null };
};

// Static copy stays static; every COUNT comes from the API. `metric` is the label shown when the
// live figure is not available, so the card never asserts a number the platform cannot back.
const workspaces = [
  { group: "Sales", title: "Revenue & CRM", detail: "Leads, RNR, renewals, cross-sell, incentives and leaderboard.", href: "/team/sales", metric: "Live CRM", tone: "purple", live: () => null as string | null },
  { group: "Sales", title: "Daily revenue priority", detail: "Real, targetable daily opportunity list combining customer scoring, open inbound leads and subscription renewals - not fabricated demo rows.", href: "/team/daily-revenue", metric: "Real ₹ target", tone: "purple", live: (data: Overview) => data.commandStrip.revenueActions == null ? null : `${data.commandStrip.revenueActions} ranked today` },
  { group: "Sales", title: "Customer reminders", detail: "Grooming rebooking cadence, subscription unused-session prompts and renewal reminders - real, governed, queued into the outbox automatically.", href: "/team/customer-reminders", metric: "Auto every 5 min", tone: "purple", live: () => null },
  { group: "Operations", title: "Bookings & delivery", detail: "Live bookings, assignments, delays, partner work orders, completion evidence and escalations.", href: "/team/operations", metric: "Live bookings", tone: "orange", live: (data: Overview) => data.workspaces.bookingsToday == null ? null : `${data.workspaces.bookingsToday} booking${data.workspaces.bookingsToday === 1 ? "" : "s"} today` },
  { group: "Customer experience", title: "Tickets & recovery", detail: "Customer 360, complaints, refund cases, RNR compliance, SLA and resolution evidence.", href: "/team/customer-experience", metric: "Open tickets", tone: "rose", live: (data: Overview) => data.workspaces.ticketsNeedAttention == null ? null : `${data.workspaces.ticketsNeedAttention} need attention` },
  { group: "Finance", title: "Accounts & collections", detail: "Collections, payouts, refunds, reconciliation and mandatory day closure.", href: "/team/finance", metric: "Day close", tone: "green", live: (data: Overview) => data.workspaces.dayCloseStatus == null ? null : `Day close ${data.workspaces.dayCloseStatus.replace(/_/g, " ")}` },
  { group: "People", title: "HR & performance", detail: "Employees, attendance, payroll, targets, incentives and team achievement.", href: "/team/people", metric: "Team directory", tone: "blue", live: (data: Overview) => data.workspaces.activeEmployees == null ? null : `${data.workspaces.activeEmployees} active employee${data.workspaces.activeEmployees === 1 ? "" : "s"}` },
  // The AI workspace had no entry point anywhere in Team: nothing linked to /team/ai, so the whole
  // module was reachable only by typing the URL. The metric leads with the rollout stage because
  // that is what decides whether the assistant is talking to anyone at all.
  { group: "AI", title: "Assistant & handoff", detail: "Conversation analytics, the human handoff queue, assistant grounding and the staff-first rollout switch. The assistant never acts autonomously on money, refunds or assignments.", href: "/team/ai", metric: "Rollout off", tone: "blue", live: (data: Overview) => data.workspaces.aiRolloutStage == null ? null : data.workspaces.aiRolloutStage === "off" ? "Rollout off · humans answer" : `${data.workspaces.aiRolloutStage.replace(/_/g, " ")}${data.workspaces.aiHandoffsWaiting ? ` · ${data.workspaces.aiHandoffsWaiting} awaiting staff` : ""}` },
  { group: "Marketing", title: "Segments & campaigns", detail: "Consent-safe audiences, WATI and SMS queues, promotions and campaign performance.", href: "/team/marketing", metric: "Live delivery locked", tone: "gold", live: () => null },
] as const;

const DASH = "—";
const show = (value: number | null | undefined) => value == null ? DASH : String(value);
const greeting = (name: string) => {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }).format(new Date()));
  const part = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  return `Good ${part}${name ? `, ${name.split(" ")[0]}` : ""}.`;
};
const initials = (name: string, email: string) => {
  const source = (name || email || "").replace(/@.*/, "").trim();
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "PS";
};

export default function TeamHome() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let on = true;
    void fetch("/api/team-overview", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { data?: Overview; error?: string };
        if (!response.ok) throw new Error(body.error || "Unable to load the Team overview");
        if (on) setData(body.data ?? null);
      })
      .catch((problem) => { if (on) setError(problem instanceof Error ? problem.message : "Unable to load the Team overview"); });
    return () => { on = false; };
  }, []);

  const strip = data?.commandStrip;
  const sla = strip?.firstResponseMinutes == null ? DASH : `${strip.firstResponseMinutes} min`;
  const slaNote = strip?.managerAlertMinutes == null ? "no lead SLA recorded yet" : `manager alert at ${strip.managerAlertMinutes} min`;
  const packReports = strip?.commandPackReports;
  const packLabel = packReports == null ? DASH : packReports > 0 ? "Ready" : "Not generated";
  const packNote = packReports == null ? "command reports unavailable" : packReports > 0 ? `${packReports} report${packReports === 1 ? "" : "s"} generated today` : "daily pack runs after 7 PM IST";

  return (
    <main className={styles.shell}>
      <header className={styles.topbar}>
        <Link href="/" className={styles.brand}><b>paw</b>space <span>TEAM</span></Link>
        <nav aria-label="PawSpace experiences"><Link href="/">Customer</Link><Link href="/partner">Partner</Link><Link className={styles.active} href="/team">Team</Link><Link href="/control">Control</Link></nav>
        <div className={styles.user}><span>{data ? initials(data.actor.name, data.actor.email) : "PS"}</span><div><b>{data ? data.actor.name.split(" ")[0] : "Signed in"}</b><small>{data ? data.actor.roleCode.replace(/_/g, " ") : "loading role"}</small></div></div>
      </header>
      <section className={styles.hero}>
        <div><p>ONE TEAM WORKSPACE</p><h1>{greeting(data?.actor.name ?? "")}</h1><span>Sales, CX, Operations, Finance, HR and Marketing now work from one front door. Your role controls what you can open.</span></div>
        <Link href="/team/operations/bookings">Open Booking Command Center <b>→</b></Link>
      </section>
      {error && <p role="alert" style={{ margin: "0 auto 12px", maxWidth: 1180, color: "#b42318" }}>{error}</p>}
      <section className={styles.commandStrip} aria-label="Today at PawSpace">
        <article><span>Revenue actions</span><b>{show(strip?.revenueActions)}</b><small>ranked and assigned</small></article>
        <article><span>First-response SLA</span><b>{sla}</b><small>{slaNote}</small></article>
        <article><span>Open escalations</span><b>{show(strip?.openEscalations)}</b><small>{strip?.openTickets == null ? "no ticket data yet" : `of ${strip.openTickets} open ticket${strip.openTickets === 1 ? "" : "s"}`}</small></article>
        <article><span>7 PM command pack</span><b>{packLabel}</b><small>{packNote}</small></article>
      </section>
      {/* The synthetic transaction engine lived on /admin and /ops; this front door replaced them. */}
      <TestSyncPanel surface="ops" />
      <section className={styles.workspaceSection}>
        <div className={styles.sectionHead}><div><p>ROLE-BASED WORKSPACES</p><h2>Choose what you need to run.</h2></div><span>6 teams · 1 customer record · 1 audit trail</span></div>
        <div className={styles.grid}>{workspaces.map((workspace) => <Link href={workspace.href} className={`${styles.card} ${styles[workspace.tone]}`} key={workspace.group + workspace.title}><div><span>{workspace.group}</span><i aria-hidden="true">↗</i></div><h3>{workspace.title}</h3><p>{workspace.detail}</p><footer><b>{(data && workspace.live(data)) || workspace.metric}</b><span>Open workspace →</span></footer></Link>)}</div>
      </section>
      <footer className={styles.footer}><div><i></i><span>UAT workspace · sandbox payments and queued communications</span></div><Link href="/control">Founder &amp; system controls →</Link></footer>
    </main>
  );
}
