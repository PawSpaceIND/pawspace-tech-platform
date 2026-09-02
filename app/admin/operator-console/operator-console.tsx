"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import styles from "./operator-console.module.css";

type Campaign = {
  code: string;
  label: string;
  requiresMarketingConsent: boolean;
  description: string;
  whatsappTemplate?: string;
};

type CampaignReadiness = {
  campaign: string;
  label: string;
  requiresMarketingConsent: boolean;
  ready: number;
  refreshedAt: number | null;
};

type CampaignOverview = { campaigns: Campaign[]; readiness: CampaignReadiness[] };

type OutboundCall = {
  id: string;
  campaign: string;
  contactId: string;
  phone: string;
  status: string;
  callRef: string | null;
  reason: string | null;
  requestedBy: string;
  createdAt: number;
};

type CommunicationsSummary = {
  messages?: number | null;
  suppressed?: number | null;
  pending?: number | null;
  dead_letter?: number | null;
  delivered?: number | null;
};

type OutboxRow = {
  message_id?: string;
  status?: string;
  attempt_count?: number;
  next_attempt_at?: number;
  updated_at?: number;
  customer_id?: string;
  booking_id?: string | null;
  channel?: string;
  purpose?: string;
  template_key?: string;
};

type CommunicationsData = { summary?: CommunicationsSummary | null; outbox?: OutboxRow[] };

type PendingClaim = {
  dispositionId: string;
  leadId: string;
  contactId: string;
  phone: string;
  primaryTag: string;
  claimTags: string[];
  notes: string | null;
  createdAt: number;
};

type TriggerResult = {
  connected: boolean;
  campaign: string;
  dialled: number;
  skipped: number;
  failed: number;
  audience: number;
  whatsappSent: number;
  whatsappSkipped: number;
  reason?: string;
};

type ApiEnvelope<T> = { data?: T; error?: string };
type HttpError = Error & { status?: number };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers, cache: "no-store", credentials: "same-origin" });
  const body = await response.json().catch(() => ({})) as ApiEnvelope<T>;
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status})`) as HttpError;
    error.status = response.status;
    throw error;
  }
  if (body.data === undefined) throw new Error("The server returned no data");
  return body.data;
}

function panelError(error: unknown, permission: string): string {
  const problem = error as HttpError;
  if (problem?.status === 401 || problem?.status === 403) return `Access restricted. Required permission: ${permission}.`;
  return problem instanceof Error ? problem.message : "Unable to load this panel";
}

function when(value?: number | null): string {
  if (!value) return "Not yet";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "Unknown";
}

function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 4 ? `••••••${digits.slice(-4)}` : "Not available";
}

function asCount(value: number | null | undefined): number {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

export default function OperatorConsole() {
  const [overview, setOverview] = useState<CampaignOverview | null>(null);
  const [calls, setCalls] = useState<OutboundCall[]>([]);
  const [communications, setCommunications] = useState<CommunicationsData | null>(null);
  const [claims, setClaims] = useState<PendingClaim[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [campaignLimit, setCampaignLimit] = useState(25);
  const [triggering, setTriggering] = useState("");
  const [reconciling, setReconciling] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    const [campaignResult, callsResult, communicationsResult, claimsResult] = await Promise.allSettled([
      api<CampaignOverview>("/api/haptik-outbound"),
      api<OutboundCall[]>("/api/haptik-outbound?mode=calls&limit=200"),
      api<CommunicationsData>("/api/communications"),
      api<PendingClaim[]>("/api/bot-call-outcomes?scope=pending_claims&limit=100"),
    ]);

    const nextErrors: Record<string, string> = {};
    if (campaignResult.status === "fulfilled") setOverview(campaignResult.value);
    else nextErrors.campaigns = panelError(campaignResult.reason, "marketing.view");

    if (callsResult.status === "fulfilled") setCalls(callsResult.value);
    else nextErrors.calls = panelError(callsResult.reason, "marketing.view");

    if (communicationsResult.status === "fulfilled") setCommunications(communicationsResult.value);
    else nextErrors.communications = panelError(communicationsResult.reason, "communications.manage");

    if (claimsResult.status === "fulfilled") setClaims(claimsResult.value);
    else nextErrors.claims = panelError(claimsResult.reason, "customers.view");

    setErrors(nextErrors);
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const readinessByCampaign = useMemo(() => new Map((overview?.readiness ?? []).map(row => [row.campaign, row])), [overview]);
  const metricsByCampaign = useMemo(() => {
    const map = new Map<string, { attempts: number; dialled: number; failed: number }>();
    for (const call of calls) {
      const current = map.get(call.campaign) ?? { attempts: 0, dialled: 0, failed: 0 };
      current.attempts += 1;
      if (call.status === "dialled") current.dialled += 1;
      if (call.status === "failed") current.failed += 1;
      map.set(call.campaign, current);
    }
    return map;
  }, [calls]);

  const readyAudience = (overview?.readiness ?? []).reduce((sum, row) => sum + asCount(row.ready), 0);
  const commSummary = communications?.summary ?? {};
  const outboxRows = communications?.outbox ?? [];

  async function triggerCampaign(campaign: string) {
    setTriggering(campaign);
    setNotice("");
    try {
      const limit = Math.max(1, Math.min(5000, Math.floor(campaignLimit || 1)));
      const result = await api<TriggerResult>("/api/haptik-outbound", {
        method: "POST",
        body: JSON.stringify({ campaign, limit }),
      });
      const message = result.reason
        ? `${campaign}: ${result.reason}`
        : `${campaign}: ${result.dialled} voice call(s), ${result.whatsappSent} WhatsApp message(s), ${result.failed} failure(s).`;
      setNotice(message);
      await refresh();
    } catch (error) {
      setNotice(panelError(error, "marketing.manage"));
    } finally {
      setTriggering("");
    }
  }

  async function reconcileClaim(claim: PendingClaim, outcome: "confirmed" | "not_found") {
    const note = (notes[claim.dispositionId] ?? "").trim();
    if (note.length < 5) {
      setNotice("Add a reconciliation note of at least 5 characters before submitting.");
      return;
    }
    setReconciling(claim.dispositionId);
    setNotice("");
    try {
      await api<unknown>("/api/bot-call-outcomes", {
        method: "POST",
        body: JSON.stringify({ action: "reconcile", dispositionId: claim.dispositionId, outcome, note }),
      });
      setNotice(`${claim.dispositionId} marked ${outcome === "confirmed" ? "confirmed" : "not found"}.`);
      setNotes(current => ({ ...current, [claim.dispositionId]: "" }));
      await refresh();
    } catch (error) {
      setNotice(panelError(error, "customers.manage"));
    } finally {
      setReconciling("");
    }
  }

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>PawSpace · governed outbound operations</p>
          <h1>Operator Console</h1>
          <p>Campaign readiness, communication outbox health, and bot-call claim reconciliation from the existing permission-gated APIs.</p>
        </div>
        <div className={styles.headerActions}>
          <Link href="/admin" className={styles.secondaryButton}>← Admin</Link>
          <button type="button" className={styles.primaryButton} onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing…" : "Refresh live data"}</button>
        </div>
      </header>

      {notice && <div className={styles.notice} role="status">{notice}</div>}

      <section className={styles.metrics} aria-label="Operator metrics">
        <article><span>Campaigns</span><strong>{overview?.campaigns.length ?? 0}</strong><small>Governed Haptik campaigns</small></article>
        <article><span>Ready audience</span><strong>{readyAudience}</strong><small>Latest readiness snapshot</small></article>
        <article><span>Outbox pending</span><strong>{asCount(commSummary.pending)}</strong><small>{asCount(commSummary.delivered)} delivered</small></article>
        <article><span>Dead letter</span><strong>{asCount(commSummary.dead_letter)}</strong><small>{asCount(commSummary.suppressed)} suppressed</small></article>
        <article><span>Claims to review</span><strong>{claims.length}</strong><small>Converted / paid bot claims</small></article>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <div><p className={styles.kicker}>Outbound</p><h2>Campaign execution</h2></div>
          <label className={styles.limitControl}>Per-run limit<input type="number" min={1} max={5000} value={campaignLimit} onChange={(event: ChangeEvent<HTMLInputElement>) => setCampaignLimit(Number(event.target.value) || 1)} /></label>
        </div>
        {(errors.campaigns || errors.calls) && <p className={styles.error}>{errors.campaigns || errors.calls}</p>}
        <div className={styles.tableWrap}>
          <table>
            <thead><tr><th>Campaign</th><th>Ready</th><th>Recent attempts</th><th>Dialled</th><th>Failed</th><th>WhatsApp</th><th>Action</th></tr></thead>
            <tbody>
              {(overview?.campaigns ?? []).map(campaign => {
                const readiness = readinessByCampaign.get(campaign.code);
                const metric = metricsByCampaign.get(campaign.code) ?? { attempts: 0, dialled: 0, failed: 0 };
                return <tr key={campaign.code}>
                  <td><strong>{campaign.label}</strong><small>{campaign.description}</small><code>{campaign.code}</code></td>
                  <td><strong>{readiness?.ready ?? 0}</strong><small>{readiness?.refreshedAt ? when(readiness.refreshedAt) : "Not refreshed"}</small></td>
                  <td>{metric.attempts}</td><td>{metric.dialled}</td><td>{metric.failed}</td>
                  <td>{campaign.whatsappTemplate ? <><span className={styles.statusDot}>Enabled</span><small>{campaign.whatsappTemplate}</small></> : <span>Voice only</span>}</td>
                  <td><button type="button" className={styles.primaryButton} onClick={() => void triggerCampaign(campaign.code)} disabled={Boolean(triggering)}>{triggering === campaign.code ? "Running…" : "Run campaign"}</button></td>
                </tr>;
              })}
              {!loading && !overview?.campaigns.length && !errors.campaigns && <tr><td colSpan={7} className={styles.empty}>No campaigns returned.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className={styles.guardrail}>The console does not send a quiet-hours override. Any launch still passes the existing server-side consent, frequency-cap, idempotency, provider-readiness, and permission gates.</p>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHeader}><div><p className={styles.kicker}>Communications</p><h2>Message outbox</h2></div><span className={styles.muted}>{asCount(commSummary.messages)} total messages</span></div>
        {errors.communications && <p className={styles.error}>{errors.communications}</p>}
        <div className={styles.tableWrap}>
          <table>
            <thead><tr><th>Status</th><th>Channel</th><th>Purpose</th><th>Template</th><th>Attempts</th><th>Next attempt</th><th>Updated</th></tr></thead>
            <tbody>
              {outboxRows.slice(0, 25).map((row, index) => <tr key={row.message_id ?? `outbox-${index}`}>
                <td><span className={styles.statusPill}>{row.status || "unknown"}</span></td>
                <td>{row.channel || "—"}</td><td>{row.purpose || "—"}</td><td><code>{row.template_key || "—"}</code></td>
                <td>{asCount(row.attempt_count)}</td><td>{when(row.next_attempt_at)}</td><td>{when(row.updated_at)}</td>
              </tr>)}
              {!loading && !outboxRows.length && !errors.communications && <tr><td colSpan={7} className={styles.empty}>Outbox is empty.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHeader}><div><p className={styles.kicker}>Reconciliation</p><h2>Bot-call outcome review queue</h2></div><span className={styles.queueCount}>{claims.length} pending</span></div>
        {errors.claims && <p className={styles.error}>{errors.claims}</p>}
        <div className={styles.claims}>
          {claims.map(claim => <article key={claim.dispositionId} className={styles.claimCard}>
            <div className={styles.claimMeta}>
              <div><strong>{claim.claimTags.join(", ") || claim.primaryTag}</strong><small>{claim.dispositionId}</small></div>
              <time>{when(claim.createdAt)}</time>
            </div>
            <dl><div><dt>Lead</dt><dd>{claim.leadId}</dd></div><div><dt>Contact</dt><dd>{claim.contactId}</dd></div><div><dt>Phone</dt><dd>{maskPhone(claim.phone)}</dd></div></dl>
            {claim.notes && <p className={styles.botNote}>{claim.notes}</p>}
            <label>Reconciliation note<textarea value={notes[claim.dispositionId] ?? ""} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setNotes(current => ({ ...current, [claim.dispositionId]: event.target.value }))} placeholder="What booking/payment evidence was checked?" /></label>
            <div className={styles.reviewActions}>
              <button type="button" className={styles.primaryButton} disabled={Boolean(reconciling)} onClick={() => void reconcileClaim(claim, "confirmed")}>{reconciling === claim.dispositionId ? "Saving…" : "Confirm against record"}</button>
              <button type="button" className={styles.secondaryButton} disabled={Boolean(reconciling)} onClick={() => void reconcileClaim(claim, "not_found")}>Mark not found</button>
            </div>
          </article>)}
          {!loading && !claims.length && !errors.claims && <div className={styles.emptyCard}>No bot claims are waiting for reconciliation.</div>}
        </div>
      </section>
    </main>
  );
}
