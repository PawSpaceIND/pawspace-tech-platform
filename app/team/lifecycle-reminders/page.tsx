"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, EmptyState, StatCard } from "../../components/ui";
import OpsShell from "../../components/ops-shell/OpsShell";
import styles from "../team-console.module.css";

type Rule = {
  id: string;
  segment: string;
  service_code: string | null;
  trigger_code: string;
  delay_days: number | null;
  repeat_days: number | null;
  template_key: string;
  active: number;
  configuration_required: number;
  notes: string;
};

type Directory = { rules: Rule[]; active: number; configurationRequired: number; deliveryBoundary: string };
const words = (value: unknown) => String(value ?? "").replaceAll("_", " ");

export default function LifecycleRemindersPage() {
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [form, setForm] = useState({ delayDays: "", repeatDays: "", templateKey: "", active: false, reason: "" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/lifecycle-reminders", { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as { data?: Directory; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error || `Unable to load lifecycle reminders (HTTP ${response.status})`);
      setDirectory(body.data);
      setError("");
      setSelectedId((prior) => prior || body.data?.rules[0]?.id || "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => { const timer = setTimeout(() => { void load(); }, 0); return () => clearTimeout(timer); }, [load]);
  const selected = useMemo(() => directory?.rules.find((rule) => rule.id === selectedId) || null, [directory, selectedId]);
  useEffect(() => {
    if (!selected) return;
    const timer = setTimeout(() => {
      setForm({
        delayDays: selected.delay_days == null ? "" : String(selected.delay_days),
        repeatDays: selected.repeat_days == null ? "" : String(selected.repeat_days),
        templateKey: selected.template_key,
        active: Boolean(selected.active),
        reason: "",
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [selected]);

  async function save() {
    if (!selected) return;
    setBusy(true); setNotice(""); setError("");
    try {
      const response = await fetch("/api/lifecycle-reminders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "save_rule",
          id: selected.id,
          delayDays: form.delayDays === "" ? null : Number(form.delayDays),
          repeatDays: form.repeatDays === "" ? null : Number(form.repeatDays),
          templateKey: form.templateKey,
          active: form.active,
          reason: form.reason,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error || `Unable to save reminder rule (HTTP ${response.status})`);
      setNotice("Reminder rule saved and audited.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  async function runNow() {
    setBusy(true); setNotice(""); setError("");
    try {
      const response = await fetch("/api/lifecycle-reminders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "run_now" }) });
      const body = (await response.json().catch(() => ({}))) as { data?: { existingGoverned?: { grooming?: { queued?: number }; subscription?: { sessionReminders?: number; renewalReminders?: number } } }; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error || `Reminder sweep failed (HTTP ${response.status})`);
      const grooming = Number(body.data.existingGoverned?.grooming?.queued || 0);
      const sessions = Number(body.data.existingGoverned?.subscription?.sessionReminders || 0);
      const renewals = Number(body.data.existingGoverned?.subscription?.renewalReminders || 0);
      setNotice(`Sweep completed: ${grooming} grooming, ${sessions} unused-session and ${renewals} renewal reminder(s) queued.`);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  return <OpsShell
    eyebrow="PawSpace · Lifecycle automation"
    title="Customer & service reminder engine"
    description="One governed module for new customers, existing customers, subscriptions and every PawSpace service. Confirmed business rules can be activated; unknown cadences stay blocked as configuration-required instead of being guessed."
    actions={<Badge tone={directory?.configurationRequired ? "warning" : "success"} dot>{directory?.configurationRequired || 0} rules need configuration</Badge>}
  >
    {error ? <div className={`${styles.panel} ${styles.panelError}`}><b>{error}</b></div> : null}
    {notice ? <div className={styles.panel}>{notice}</div> : null}

    <section className={styles.tiles}>
      <StatCard label="Rules" value={directory?.rules.length ?? "—"} meta="all customer/service segments" />
      <StatCard label="Active" value={directory?.active ?? "—"} meta="confirmed business logic only" />
      <StatCard label="Needs configuration" value={directory?.configurationRequired ?? "—"} meta="blocked until approved" />
      <StatCard label="Delivery" value="Sandbox" meta="governed outbox; external provider off" />
    </section>

    <section className={styles.panel}>
      <div className={styles.panelHead}><h2>Business-rule matrix</h2><Button size="sm" variant="secondary" disabled={busy} onClick={() => { void runNow(); }}>{busy ? "Running…" : "Run confirmed reminders now"}</Button></div>
      <p className={styles.panelNote}>Grooming rebooking and the existing grooming-subscription rules inherit their current governed cadence. New-customer, existing-customer and other-service rules are present but remain inactive until a real business cadence/template is approved.</p>
      {directory?.rules.length ? <div className={styles.tableWrap}><table className={styles.table}>
        <thead><tr><th>Segment</th><th>Service</th><th>Trigger</th><th>Delay</th><th>Repeat</th><th>Status</th></tr></thead>
        <tbody>{directory.rules.map((rule) => <tr key={rule.id} onClick={() => setSelectedId(rule.id)} style={{ cursor: "pointer" }}>
          <td>{words(rule.segment)}</td><td>{rule.service_code ? words(rule.service_code) : "all"}</td><td>{words(rule.trigger_code)}</td>
          <td>{rule.delay_days == null ? "—" : `${rule.delay_days}d`}</td><td>{rule.repeat_days == null ? "—" : `${rule.repeat_days}d`}</td>
          <td>{rule.active ? <Badge tone="success">active</Badge> : rule.configuration_required ? <Badge tone="warning">configure</Badge> : <Badge tone="neutral">paused</Badge>}</td>
        </tr>)}</tbody>
      </table></div> : <EmptyState title="No reminder rules yet" body="Reload the module to seed the governed rule directory." />}
    </section>

    {selected ? <section className={styles.panel}>
      <div className={styles.panelHead}><h2>Edit: {words(selected.segment)} · {selected.service_code ? words(selected.service_code) : "all services"}</h2>{selected.configuration_required ? <Badge tone="warning">configuration required</Badge> : <Badge tone="success">configured</Badge>}</div>
      <p className={styles.panelNote}>{selected.notes}</p>
      <div className={styles.fieldRow}>
        <label className={styles.field}>Delay after trigger (days)<input inputMode="numeric" value={form.delayDays} onChange={(event) => setForm({ ...form, delayDays: event.target.value })} placeholder="0 for immediate" /></label>
        <label className={styles.field}>Repeat cadence (days, optional)<input inputMode="numeric" value={form.repeatDays} onChange={(event) => setForm({ ...form, repeatDays: event.target.value })} placeholder="leave blank for one-time" /></label>
        <label className={styles.field}>Template key<input value={form.templateKey} onChange={(event) => setForm({ ...form, templateKey: event.target.value })} /></label>
      </div>
      <label className={styles.field}>Change reason<input value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} placeholder="Why this customer/service reminder rule is changing" /></label>
      <div className={styles.actions} style={{ marginTop: 12 }}>
        <label><input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.target.checked })} /> Active</label>
        <Button size="sm" disabled={busy || form.reason.trim().length < 8} onClick={() => { void save(); }}>Save rule</Button>
      </div>
    </section> : null}

    <footer className={styles.footnote}><b>Important:</b> this module governs reminder logic and the existing communications outbox. Live WhatsApp/SMS/email delivery remains off until the corresponding production provider credentials and controlled-live verification are completed.</footer>
  </OpsShell>;
}
