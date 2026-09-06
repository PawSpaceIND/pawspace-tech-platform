"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, EmptyState } from "../../../components/ui";
import OpsShell from "../../../components/ops-shell/OpsShell";
import teamStyles from "../../team-console.module.css";

type Row = Record<string, unknown>;
type Usage = { sends?: number; delivered?: number; replies?: number; bookings?: number };
type Template = Row & {
  template_key?: string;
  display_name?: string;
  status?: string;
  category?: string;
  approved_language?: string;
  body?: string;
  meta_reconciliation_status?: string;
  meta_reference?: string;
  reconciliation_note?: string;
  updated_by?: string;
  updated_at?: number;
  sampleValues?: string[];
  samplePayload?: { renderedBody?: string };
  usage?: Usage;
};
type TemplateData = { templates?: Template[]; events?: Row[]; productionDelivery?: boolean; externalMetaMutation?: boolean; environment?: string };

const text = (value: unknown, fallback = "—") => String(value ?? "").trim() || fallback;
const pretty = (value: unknown) => text(value).replaceAll("_", " ");
const dateTime = (value: unknown) => value ? new Date(Number(value)).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "—";
const samplesFrom = (value: string) => value.split("\n").map((item) => item.trim()).filter(Boolean);

const emptyDraft = {
  templateKey: "",
  displayName: "",
  category: "utility",
  language: "en",
  body: "",
  samples: "",
};

export default function WhatsAppTemplatesPage() {
  const [data, setData] = useState<TemplateData>({});
  const [draft, setDraft] = useState(emptyDraft);
  const [reason, setReason] = useState("Verified WhatsApp template lifecycle change");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [filter, setFilter] = useState("all");

  const load = useCallback(async () => {
    const response = await fetch("/api/whatsapp/templates", { cache: "no-store" });
    const payload = await response.json().catch(() => ({})) as { data?: TemplateData; error?: string };
    if (!response.ok) throw new Error(payload.error || `Unable to load WhatsApp templates (HTTP ${response.status})`);
    setData(payload.data || {});
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function act(action: string, payload: Row) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/whatsapp/templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...payload }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string; data?: Row };
      if (!response.ok) throw new Error(body.error || `Template action failed (HTTP ${response.status})`);
      await load();
      if (action === "verify_meta") setNotice(`Meta status verified: ${pretty(body.data?.remoteStatus || body.data?.status || "updated")}.`);
      else setNotice(action === "save_draft" ? "Draft saved to the governed template registry." : `Template ${pretty(action)} recorded.`);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    const saved = await act("save_draft", {
      templateKey: draft.templateKey,
      displayName: draft.displayName,
      category: draft.category,
      language: draft.language,
      body: draft.body,
      sampleValues: samplesFrom(draft.samples),
    });
    if (saved) setDraft(emptyDraft);
  }

  function edit(row: Template) {
    setDraft({
      templateKey: text(row.template_key, ""),
      displayName: text(row.display_name, ""),
      category: text(row.category, "utility"),
      language: text(row.approved_language, "en"),
      body: text(row.body, ""),
      samples: (row.sampleValues || []).join("\n"),
    });
  }

  const templates = data.templates || [];
  const visible = useMemo(() => filter === "all" ? templates : templates.filter((row) => text(row.status, "") === filter), [templates, filter]);
  const counts = useMemo(() => templates.reduce<Record<string, number>>((acc, row) => { const key = text(row.status, "unknown"); acc[key] = (acc[key] || 0) + 1; return acc; }, {}), [templates]);
  const draftDirty = draft.templateKey !== "" || draft.displayName !== "" || draft.category !== "utility" || draft.language !== "en" || draft.body !== "" || draft.samples !== "";

  return (
    <OpsShell
      eyebrow="PawSpace team · WhatsApp"
      title="Templates & lifecycle control"
      description="Create and submit WhatsApp templates, then verify approval directly against the connected Meta WABA. PawSpace never trusts an operator-entered approval outcome."
      actions={<><Badge tone="info">Governed registry</Badge><Badge tone="neutral">Meta status verified</Badge><Badge tone="warning">No live Meta mutation</Badge></>}
    >
      {error ? <div className={`${teamStyles.panel} ${teamStyles.panelError}`}><b>{error}</b></div> : null}
      {notice ? <div className={teamStyles.panel}><b>{notice}</b></div> : null}

      <section className={teamStyles.panel}>
        <div className={teamStyles.panelHead}><h2>Template editor</h2><span>Draft → Submit → Meta verification → Approved / Rejected / Paused</span></div>
        <p className={teamStyles.panelNote}>Use numeric variables such as {"{{1}}"}, {"{{2}}"} in sequence. Put one sample value per line. Outside the 24-hour service window, the canonical WhatsApp outbox accepts only a template that Meta currently reports as approved with the matching language.</p>
        <div className={teamStyles.fieldRow}>
          <label className={teamStyles.field}>Template key<input value={draft.templateKey} onChange={(event) => setDraft((current) => ({ ...current, templateKey: event.target.value.toLowerCase() }))} placeholder="booking_followup_v1" maxLength={64} /></label>
          <label className={teamStyles.field}>Display name<input value={draft.displayName} onChange={(event) => setDraft((current) => ({ ...current, displayName: event.target.value }))} placeholder="Booking follow-up" maxLength={100} /></label>
          <label className={teamStyles.field}>Category<select value={draft.category} onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value }))}><option value="utility">Utility</option><option value="authentication">Authentication</option><option value="marketing">Marketing</option></select></label>
          <label className={teamStyles.field}>Language<input value={draft.language} onChange={(event) => setDraft((current) => ({ ...current, language: event.target.value }))} placeholder="en" maxLength={8} /></label>
        </div>
        <div className={teamStyles.fieldRow}>
          <label className={teamStyles.field}>Body<textarea rows={5} value={draft.body} onChange={(event) => setDraft((current) => ({ ...current, body: event.target.value }))} placeholder="Hi {{1}}, your PawSpace booking for {{2}} is ready." maxLength={1024} /></label>
          <label className={teamStyles.field}>Sample values — one per variable<textarea rows={5} value={draft.samples} onChange={(event) => setDraft((current) => ({ ...current, samples: event.target.value }))} placeholder={"Asha\nGrooming"} /></label>
        </div>
        <div className={teamStyles.actions}><Button type="button" disabled={busy} onClick={() => { void saveDraft(); }}>Save governed draft</Button><Button type="button" variant="secondary" disabled={busy || !draftDirty} onClick={() => setDraft(emptyDraft)}>Clear</Button></div>
      </section>

      <section className={teamStyles.panel}>
        <div className={teamStyles.panelHead}><h2>Lifecycle controls</h2><span>Every transition is audited</span></div>
        <div className={teamStyles.fieldRow}>
          <label className={teamStyles.field}>Change reason<input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={240} /></label>
        </div>
        <p className={teamStyles.panelNote}>“Submit” records the local draft as awaiting provider review. “Verify with Meta” performs a live Graph API status read for this template and applies only the provider-returned status, language, category and template ID. There is no manual approve/reject control.</p>
      </section>

      <div className={teamStyles.controls}>
        {[["all", "All"], ["draft", "Draft"], ["submitted", "Submitted"], ["approved", "Approved"], ["rejected", "Rejected"], ["paused", "Paused"]].map(([key, label]) => <Button key={key} type="button" size="sm" variant={filter === key ? "primary" : "secondary"} onClick={() => setFilter(key)}>{label}{key === "all" ? ` ${templates.length}` : ` ${counts[key] || 0}`}</Button>)}
      </div>

      {visible.length === 0 ? <EmptyState title="No templates in this view." body="Create a governed draft above to start the lifecycle." /> : <div className={teamStyles.tableWrap}>
        <table className={teamStyles.table}>
          <thead><tr><th>Template</th><th>Status</th><th>Preview</th><th>Meta verification</th><th>Usage</th><th>Actions</th></tr></thead>
          <tbody>{visible.map((row) => {
            const key = text(row.template_key);
            const status = text(row.status, "draft");
            const usage = row.usage || {};
            return <tr key={key}>
              <td><div className={teamStyles.stack}><b>{text(row.display_name, key)}</b><small>{key}</small><small>{pretty(row.category)} · {text(row.approved_language)}</small><small>Updated {dateTime(row.updated_at)} · {text(row.updated_by, "system")}</small></div></td>
              <td><Badge tone={status === "approved" ? "success" : status === "rejected" || status === "paused" ? "warning" : "info"}>{pretty(status)}</Badge></td>
              <td><div className={teamStyles.stack}><span>{text(row.samplePayload?.renderedBody || row.body, "No body")}</span><small>{(row.sampleValues || []).length} sample variable(s)</small></div></td>
              <td><div className={teamStyles.stack}><b>{pretty(row.meta_reconciliation_status || "not submitted")}</b><small>{text(row.meta_reference, "No Meta template ID")}</small><small>{text(row.reconciliation_note, "Not verified yet")}</small></div></td>
              <td><div className={teamStyles.stack}><span>Sends {Number(usage.sends || 0)} · Delivered {Number(usage.delivered || 0)}</span><small>Replies {Number(usage.replies || 0)} · Bookings {Number(usage.bookings || 0)}</small></div></td>
              <td><div className={teamStyles.actions}>
                {(status === "draft" || status === "rejected") ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => edit(row)}>Edit</Button> : null}
                {(status === "draft" || status === "rejected") ? <Button size="sm" disabled={busy} onClick={() => { void act("submit", { templateKey: key, reason }); }}>Submit</Button> : null}
                {(status === "submitted" || status === "approved" || status === "paused") ? <Button size="sm" disabled={busy} onClick={() => { void act("verify_meta", { templateKey: key }); }}>Verify with Meta</Button> : null}
                {status === "approved" ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => { void act("pause", { templateKey: key, reason }); }}>Pause locally</Button> : null}
              </div></td>
            </tr>;
          })}</tbody>
        </table>
      </div>}

      <p className={teamStyles.footnote}>Safety state: environment {text(data.environment, "uat")} · production WhatsApp delivery {data.productionDelivery ? "enabled" : "disabled"} · external Meta mutation {data.externalMetaMutation ? "enabled" : "disabled"}. Approval is sourced from Meta Graph API; this screen can submit or pause PawSpace state but cannot fabricate provider approval.</p>
    </OpsShell>
  );
}
