"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, EmptyState, PageHeader, StatCard } from "../../components/ui";
import styles from "../team-console.module.css";

type Policy = { groomingRebookingDays: number; subscriptionInactivityDays: number; subscriptionRenewalDays: number; isDefault: boolean };
type ReminderEvent = { id: string; customer_id: string; reminder_type: string; cycle_key: string; message_id: string | null; duplicate_prevented: number; created_at: number };
type OutcomeTotal = { reminder_type: string; queued: number; suppressed: number; last_at: number };

const when = (value: number) => new Date(Number(value || 0)).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
const words = (value: unknown) => String(value || "").replaceAll("_", " ");
const FILTERS = [["all", "All"], ["queued", "Queued"], ["suppressed", "Suppressed"]] as const;

/**
 * The screen used to list only the last hundred sweep events, and because a sweep that finds nothing
 * new records a suppression, a healthy system looked like a wall of "duplicate prevented" - the
 * de-duplication working read as nothing working. Queued and suppressed are now counted separately
 * over the whole history and labelled for what they are.
 */
export default function CustomerRemindersPage() {
  const [state, setState] = useState<{ policy: Policy | null; events: ReminderEvent[]; totals: OutcomeTotal[]; error: string }>({ policy: null, events: [], totals: [], error: "" });
  const { policy, events, totals, error } = state;
  const [form, setForm] = useState({ groomingRebookingDays: 15, subscriptionInactivityDays: 10, subscriptionRenewalDays: 7, reason: "" });
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("all");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/customer-reminders", { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as { data?: { policy: Policy; recentEvents: ReminderEvent[]; outcomeTotals?: OutcomeTotal[] }; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error || `Unable to load reminder governance (HTTP ${response.status})`);
      setState({ policy: body.data.policy, events: body.data.recentEvents, totals: body.data.outcomeTotals || [], error: "" });
    } catch (cause) {
      setState((prior) => ({ ...prior, error: cause instanceof Error ? cause.message : String(cause) }));
    }
  }, []);
  useEffect(() => { const timer = setTimeout(() => { void load(); }, 0); return () => clearTimeout(timer); }, [load]);
  useEffect(() => {
    if (policy) setForm((prior) => ({ ...prior, groomingRebookingDays: policy.groomingRebookingDays, subscriptionInactivityDays: policy.subscriptionInactivityDays, subscriptionRenewalDays: policy.subscriptionRenewalDays }));
  }, [policy]);

  async function savePolicy() {
    setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/customer-reminders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "save_policy", ...form }) });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error || `Unable to save the cadence policy (HTTP ${response.status})`);
      setNotice("Cadence policy saved.");
      setForm((prior) => ({ ...prior, reason: "" }));
      await load();
    } catch (cause) { setState((prior) => ({ ...prior, error: cause instanceof Error ? cause.message : String(cause) })); }
    finally { setBusy(false); }
  }

  async function runNow() {
    setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/customer-reminders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "run_sweep_now" }) });
      const body = (await response.json().catch(() => ({}))) as { data?: { grooming: { queued: number }; subscription: { sessionReminders: number; renewalReminders: number } }; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error || `Sweep failed (HTTP ${response.status})`);
      const queued = body.data.grooming.queued + body.data.subscription.sessionReminders + body.data.subscription.renewalReminders;
      setNotice(queued
        ? `Queued ${body.data.grooming.queued} rebooking, ${body.data.subscription.sessionReminders} session-usage and ${body.data.subscription.renewalReminders} renewal reminder(s).`
        : "Nothing new was due: every customer in scope has already been reminded for their current cycle.");
      await load();
    } catch (cause) { setState((prior) => ({ ...prior, error: cause instanceof Error ? cause.message : String(cause) })); }
    finally { setBusy(false); }
  }

  const queuedTotal = totals.reduce((sum, row) => sum + Number(row.queued || 0), 0);
  const suppressedTotal = totals.reduce((sum, row) => sum + Number(row.suppressed || 0), 0);
  const lastAt = totals.reduce((latest, row) => Math.max(latest, Number(row.last_at || 0)), 0);
  const shown = events.filter((event) => filter === "all" || (filter === "queued" ? !event.duplicate_prevented : Boolean(event.duplicate_prevented)));

  return <main className={styles.shell}>
    <PageHeader
      eyebrow="PawSpace · Customer lifecycle reminders"
      title="Rebooking, subscription session & renewal reminders"
      description="Runs every five minutes on the real background scheduler and queues into the governed communications outbox. Live WhatsApp and SMS delivery stays sandboxed until production credentials are configured."
      actions={<Badge tone={queuedTotal ? "success" : "warning"} dot>{queuedTotal} reminders queued</Badge>}
    />
    <nav className={styles.nav} aria-label="Team workspaces">
      <Link href="/team">← Team Home</Link><Link href="/team/customer-experience">CX queue</Link><Link href="/team/communications">Communications</Link>
    </nav>

    {error ? <div className={`${styles.panel} ${styles.panelError}`}><b>{error}</b></div> : null}
    {notice ? <div className={styles.panel}>{notice}</div> : null}

    <section className={styles.tiles}>
      <StatCard label="Reminders queued" value={queuedTotal} meta="all time" />
      <StatCard label="Suppressed as duplicate" value={suppressedTotal} meta="already reminded this cycle" />
      <StatCard label="Reminder types active" value={totals.length} />
      <StatCard label="Last sweep activity" value={lastAt ? when(lastAt).split(",")[1]?.trim() || when(lastAt) : "—"} meta={lastAt ? when(lastAt).split(",")[0] : "no sweep yet"} />
    </section>

    <section className={styles.panel}>
      <div className={styles.panelHead}><h2>Cadence policy</h2>{policy?.isDefault ? <Badge tone="warning">using default — never explicitly saved</Badge> : <Badge tone="success">saved</Badge>}</div>
      <p className={styles.panelNote}>These windows decide when a customer becomes due for a reminder. A change needs a reason, which is recorded with it.</p>
      <div className={styles.fieldRow}>
        <label className={styles.field}>Grooming rebooking (days)<input value={form.groomingRebookingDays} inputMode="numeric" onChange={(event) => setForm({ ...form, groomingRebookingDays: Number(event.target.value) || 0 })} /></label>
        <label className={styles.field}>Subscription inactivity (days)<input value={form.subscriptionInactivityDays} inputMode="numeric" onChange={(event) => setForm({ ...form, subscriptionInactivityDays: Number(event.target.value) || 0 })} /></label>
        <label className={styles.field}>Renewal reminder window (days)<input value={form.subscriptionRenewalDays} inputMode="numeric" onChange={(event) => setForm({ ...form, subscriptionRenewalDays: Number(event.target.value) || 0 })} /></label>
      </div>
      <label className={styles.field}>Change reason (required)<input value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} placeholder="e.g. Founder requested a longer grooming cadence for premium customers" /></label>
      <div className={styles.actions} style={{ marginTop: 12 }}>
        <Button size="sm" disabled={busy || form.reason.trim().length < 5} onClick={() => { void savePolicy(); }}>Save cadence policy</Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => { void runNow(); }}>{busy ? "Running…" : "Run sweep now"}</Button>
      </div>
    </section>

    {totals.length ? <section className={styles.panel}>
      <div className={styles.panelHead}><h2>Outcomes by reminder type</h2></div>
      <p className={styles.panelNote}>A suppression is not a failure: it means that customer had already been reminded for the current cycle, which is exactly what stops a five-minute sweep from messaging someone twelve times an hour.</p>
      <div className={styles.tableWrap}><table className={styles.table}>
        <thead><tr><th>Reminder</th><th className={styles.numeric}>Queued</th><th className={styles.numeric}>Suppressed</th><th>Last activity</th></tr></thead>
        <tbody>{totals.map((row) => <tr key={row.reminder_type}>
          <td>{words(row.reminder_type)}</td>
          <td className={styles.numeric}>{row.queued}</td>
          <td className={styles.numeric}>{row.suppressed}</td>
          <td><small>{when(row.last_at)}</small></td>
        </tr>)}</tbody>
      </table></div>
    </section> : null}

    <section className={styles.panel}>
      <div className={styles.panelHead}><h2>Recent sweep events</h2><div className={styles.actions}>{FILTERS.map(([value, label]) => <Button key={value} size="sm" variant={filter === value ? "primary" : "secondary"} onClick={() => setFilter(value)}>{label}</Button>)}</div></div>
      {shown.length === 0 ? <EmptyState
        title={events.length ? `No ${filter} events in the last 100` : "No sweep has run yet"}
        body={events.length ? "Switch the filter to see the other outcome." : "The scheduler runs every five minutes; you can also run a sweep now from the panel above."}
      /> : <div className={styles.tableWrap}><table className={styles.table}>
        <thead><tr><th>When</th><th>Reminder</th><th>Customer</th><th>Outcome</th></tr></thead>
        <tbody>{shown.map((event) => <tr key={event.id}>
          <td><small>{when(event.created_at)}</small></td>
          <td>{words(event.reminder_type)}</td>
          <td>{event.customer_id}</td>
          <td>{event.duplicate_prevented
            ? <Badge tone="neutral">already reminded this cycle</Badge>
            : <div className={styles.stack}><Badge tone="success">queued to outbox</Badge>{event.message_id ? <small>{event.message_id}</small> : null}</div>}</td>
        </tr>)}</tbody>
      </table></div>}
    </section>

    <footer className={styles.footnote}><b>Scheduler:</b> real, every 5 minutes · <b>Outbox:</b> governed · <b>Live WhatsApp/SMS delivery:</b> sandboxed until credentials are configured · <b>Production ready:</b> NO</footer>
  </main>;
}
