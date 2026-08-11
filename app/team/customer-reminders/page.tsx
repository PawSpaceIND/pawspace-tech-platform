"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Policy = { groomingRebookingDays: number; subscriptionInactivityDays: number; subscriptionRenewalDays: number; isDefault: boolean };
type ReminderEvent = { id: string; customer_id: string; reminder_type: string; cycle_key: string; message_id: string | null; duplicate_prevented: number; created_at: number };

export default function CustomerRemindersPage() {
  const [state, setState] = useState<{ policy: Policy | null; events: ReminderEvent[]; error: string }>({ policy: null, events: [], error: "" });
  const { policy, events, error } = state;
  const [form, setForm] = useState({ groomingRebookingDays: 15, subscriptionInactivityDays: 10, subscriptionRenewalDays: 7, reason: "" });
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/customer-reminders", { cache: "no-store" });
      const b = (await r.json()) as { data?: { policy: Policy; recentEvents: ReminderEvent[] }; error?: string };
      if (!r.ok || !b.data) throw new Error(b.error || "Unable to load");
      setState({ policy: b.data.policy, events: b.data.recentEvents, error: "" });
    } catch (e) {
      setState((s) => ({ ...s, error: e instanceof Error ? e.message : "Unable to load" }));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (policy) setForm((f) => ({ ...f, groomingRebookingDays: policy.groomingRebookingDays, subscriptionInactivityDays: policy.subscriptionInactivityDays, subscriptionRenewalDays: policy.subscriptionRenewalDays }));
  }, [policy]);

  async function savePolicy() {
    if (form.reason.trim().length < 8) { setState((s) => ({ ...s, error: "A clear reason of at least 8 characters is required" })); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/customer-reminders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "save_policy", ...form }) });
      const b = (await r.json()) as { error?: string };
      if (!r.ok) throw new Error(b.error || "Save failed");
      setNotice("Cadence policy saved");
      setForm((f) => ({ ...f, reason: "" }));
      await load();
    } catch (e) {
      setState((s) => ({ ...s, error: e instanceof Error ? e.message : "Save failed" }));
    } finally {
      setBusy(false);
    }
  }

  async function runNow() {
    setBusy(true);
    try {
      const r = await fetch("/api/customer-reminders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "run_sweep_now" }) });
      const b = (await r.json()) as { data?: { grooming: { queued: number }; subscription: { sessionReminders: number; renewalReminders: number } }; error?: string };
      if (!r.ok || !b.data) throw new Error(b.error || "Sweep failed");
      setNotice(`Queued ${b.data.grooming.queued} rebooking, ${b.data.subscription.sessionReminders} session-usage, ${b.data.subscription.renewalReminders} renewal reminder(s)`);
      await load();
    } catch (e) {
      setState((s) => ({ ...s, error: e instanceof Error ? e.message : "Sweep failed" }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: "32px 20px", fontFamily: "system-ui,sans-serif" }}>
      <p><Link href="/team">← Team</Link></p>
      <p style={{ fontWeight: 800, letterSpacing: 1 }}>PAWSPACE · CUSTOMER LIFECYCLE REMINDERS</p>
      <h1>Rebooking, subscription session & renewal reminders</h1>
      <p style={{ color: "#666" }}>Runs automatically every 5 minutes via the real background scheduler. Real message queueing into the governed communications outbox - live WhatsApp/SMS delivery remains sandboxed until production credentials are configured.</p>
      {error && <div style={{ padding: 12, background: "#fff1f1", border: "1px solid #efc2c2", borderRadius: 10, margin: "12px 0" }}>{error}</div>}
      {notice && <div style={{ padding: 12, background: "#eefaf1", border: "1px solid #b8e6c5", borderRadius: 10, margin: "12px 0" }}>{notice}</div>}
      {policy && (
        <section style={{ border: "1px solid #ddd", borderRadius: 12, padding: 20, marginTop: 16 }}>
          <h2 style={{ marginTop: 0 }}>Cadence policy {policy.isDefault && <small style={{ color: "#999" }}>(using default, never explicitly saved)</small>}</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginBottom: 12 }}>
            <label>Grooming rebooking (days)<br /><input type="number" min={1} value={form.groomingRebookingDays} onChange={(e) => setForm((f) => ({ ...f, groomingRebookingDays: Number(e.target.value) }))} style={{ width: "100%", padding: 8 }} /></label>
            <label>Subscription inactivity (days)<br /><input type="number" min={1} value={form.subscriptionInactivityDays} onChange={(e) => setForm((f) => ({ ...f, subscriptionInactivityDays: Number(e.target.value) }))} style={{ width: "100%", padding: 8 }} /></label>
            <label>Renewal reminder window (days)<br /><input type="number" min={1} value={form.subscriptionRenewalDays} onChange={(e) => setForm((f) => ({ ...f, subscriptionRenewalDays: Number(e.target.value) }))} style={{ width: "100%", padding: 8 }} /></label>
          </div>
          <label>Change reason (required)<br /><input value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} style={{ width: "100%", padding: 8 }} placeholder="e.g. Founder requested longer grooming cadence for premium customers" /></label>
          <div style={{ marginTop: 12, display: "flex", gap: 10 }}>
            <button disabled={busy} onClick={() => void savePolicy()} style={{ padding: "10px 16px" }}>Save cadence policy</button>
            <button disabled={busy} onClick={() => void runNow()} style={{ padding: "10px 16px" }}>Run sweep now</button>
          </div>
        </section>
      )}
      <section style={{ marginTop: 24 }}>
        <h2>Recent reminder events</h2>
        {!events.length && <p style={{ color: "#666" }}>No reminders queued yet.</p>}
        {events.map((e) => (
          <article key={e.id} style={{ border: "1px solid #eee", borderRadius: 10, padding: 12, marginBottom: 8 }}>
            <b>{e.reminder_type}</b> · customer {e.customer_id} · {e.duplicate_prevented ? "duplicate prevented" : "queued"} · {new Date(e.created_at).toLocaleString("en-IN")}
          </article>
        ))}
      </section>
    </main>
  );
}
