"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/*
 * "Refund after completion" on a completed booking (owner decision D, 27 Sept 2026). Operations (bookings.manage) sets a
 * percentage of what the customer paid and a reason; Finance approves or rejects it in Finance > Refunds after completion.
 * The rupee amount is shown as the percentage is typed, and the server's own figures (credit note, provider payout) follow.
 */
type Preview = { percent: number; asked: number; amount: number; capped: boolean; creditNote: { treatment: string; taxableValue: number; exemptValue: number; tax: number; pendingInvoice: boolean }; providerImpact: { stage: string; providerShare: number; label: string } };
type Position = {
  found: boolean; refusal: string | null;
  payment: { amountPaid: number; captured: number; refundedSoFar: number; pendingRequests: number; refundable: number };
  taxRecord: { treatment: string; commissionPercent: number; gstRatePercent: number } | null;
  invoice: { number: string; date: string } | null;
  preview: Preview | null;
};
type RequestRow = { id: string; status: string; percent: number; amount: number; reason: string; requested_by: string; created_at: number; decided_by?: string | null; decision_reason?: string | null; case_status?: string | null; credit_note_number?: string | null; settlement_status?: string | null };
type Loaded = { position: Position; requests: RequestRow[] };

const rupees = (value: unknown) => `₹${Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const validPercent = (raw: string) => { const p = Number(raw); return raw.trim() !== "" && Number.isFinite(p) && p >= 1 && p <= 100 && Math.abs(Math.round(p * 100) - p * 100) < 1e-6 ? p : null; };
function requestStatus(row: RequestRow) {
  if (row.status === "requested") return "Waiting for Finance approval";
  if (row.status === "rejected") return `Rejected by ${row.decided_by || "Finance"}: ${row.decision_reason || "no reason recorded"}`;
  if (row.status === "processed") return `Refunded to the original payment${row.credit_note_number ? ` · credit note ${row.credit_note_number}` : ""}`;
  if (row.case_status === "failed") return "Approved, but the gateway refund failed. Finance retries it from the refund case.";
  if (row.case_status === "processed" || row.case_status === "completed") return "Refunded; credit note and payout adjustment in progress";
  return row.case_status === "processing" ? "Approved and sent to the payment gateway" : "Approved, waiting to be sent to the payment gateway";
}
type LoadError = Error & { status?: number };
async function fetchPosition(bookingId: string, percent?: number) {
  const response = await fetch(`/api/escalation-refunds?bookingId=${encodeURIComponent(bookingId)}${percent ? `&percent=${encodeURIComponent(String(percent))}` : ""}`, { cache: "no-store" });
  const body = await response.json().catch(() => ({})) as { data?: Loaded; error?: string };
  if (!response.ok || !body.data) { const error: LoadError = new Error(body.error || "Refund details are unavailable"); error.status = response.status; throw error; }
  return body.data;
}

export default function EscalationRefundPanel({ bookingId }: { bookingId: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [percent, setPercent] = useState("");
  const [reason, setReason] = useState("");
  const [customerNote, setCustomerNote] = useState("");
  const [serverPreview, setServerPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  // Asking for a refund needs bookings.manage; for anyone else the section is not shown at all.
  const [hidden, setHidden] = useState(false);
  const [submissionKey, setSubmissionKey] = useState(() => crypto.randomUUID());
  const refresh = useCallback(async () => { const data = await fetchPosition(bookingId); setLoaded(data); return data; }, [bookingId]);
  useEffect(() => { let active = true; void fetchPosition(bookingId).then(data => { if (active) setLoaded(data); }).catch((cause: LoadError) => { if (!active) return; if (cause?.status === 401 || cause?.status === 403) setHidden(true); else setError(cause instanceof Error ? cause.message : "Refund details are unavailable"); }); return () => { active = false; }; }, [bookingId]);
  const valid = validPercent(percent);
  // The server's figures for this percentage: credit note and provider payout. The amount itself is worked out as you type.
  useEffect(() => {
    if (valid == null) return;
    let active = true;
    const timer = window.setTimeout(() => { void fetchPosition(bookingId, valid).then(data => { if (active) setServerPreview(data.position.preview); }).catch(() => { if (active) setServerPreview(null); }); }, 350);
    return () => { active = false; window.clearTimeout(timer); };
  }, [bookingId, valid]);
  const position = loaded?.position ?? null;
  const live = useMemo(() => {
    if (!position || valid == null) return null;
    const asked = round2(position.payment.amountPaid * valid / 100), amount = round2(Math.min(asked, position.payment.refundable));
    return { asked, amount, capped: amount < asked - 0.009 };
  }, [position, valid]);
  const preview = serverPreview && valid != null && serverPreview.percent === valid ? serverPreview : null;
  const ready = Boolean(live && live.amount > 0 && reason.trim().length >= 10 && !busy);

  async function submit() {
    if (!live || valid == null) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/escalation-refunds", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "request", bookingId, percent: valid, reason: reason.trim(), customerNote: customerNote.trim() || undefined, idempotencyKey: submissionKey }) });
      const body = await response.json().catch(() => ({})) as { data?: { request?: { amount?: number } }; error?: string };
      if (!response.ok) throw new Error(body.error || "The refund request was not saved");
      setNotice(`Refund of ${rupees(body.data?.request?.amount ?? live.amount)} sent to Finance for approval.`);
      setReason(""); setCustomerNote(""); setPercent(""); setServerPreview(null); setSubmissionKey(crypto.randomUUID());
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The refund request was not saved"); }
    finally { setBusy(false); }
  }

  if (hidden) return null;
  const box: React.CSSProperties = { border: "1px solid var(--staff-line, #d9d9d9)", borderRadius: 12, padding: 14, marginTop: 14, background: "var(--staff-surface, #fff)" };
  return <section style={box} aria-label="Refund after completion">
    <header><small style={{ fontWeight: 800, letterSpacing: 1, color: "var(--staff-primary, #01261f)" }}>REFUND AFTER COMPLETION</small><h3 style={{ margin: "4px 0" }}>Refund part of what the customer paid</h3><p style={{ margin: 0, color: "var(--staff-muted, #555)" }}>Finance approves it, then it goes back to the customer&apos;s original payment method. The provider&apos;s share is taken off their payout.</p></header>
    {error && <p role="alert" style={{ color: "var(--staff-danger, #b3261e)" }}>{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!position ? <p style={{ color: "var(--staff-muted, #555)" }}>Loading what this booking can refund…</p> : <>
      <p style={{ margin: "10px 0 0" }}>Customer paid <b>{rupees(position.payment.amountPaid)}</b> · refunded or waiting <b>{rupees(position.payment.refundedSoFar + position.payment.pendingRequests)}</b> · still refundable <b>{rupees(position.payment.refundable)}</b>{position.invoice ? ` · invoice ${position.invoice.number}` : " · no customer invoice yet (the credit note follows once it is issued)"}</p>
      {position.refusal ? <p style={{ fontWeight: 700 }}>{position.refusal}</p> : <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
        <label>Refund percentage (1 to 100)<br /><input type="number" min={1} max={100} step={0.01} inputMode="decimal" value={percent} onChange={event => setPercent(event.target.value)} style={{ width: 120 }} /> %</label>
        <p style={{ margin: 0 }} aria-live="polite">{live ? <>Refund: <b>{rupees(live.amount)}</b>{live.capped ? ` (capped at what is still refundable; ${rupees(live.asked)} asked)` : ""}</> : percent ? "Enter 1 to 100, with at most two decimals." : "Enter a percentage to see the amount."}</p>
        {preview && <p style={{ margin: 0, color: "var(--staff-muted, #555)" }}>Credit note: {preview.creditNote.tax > 0 ? `taxable value ${rupees(preview.creditNote.taxableValue)}, GST ${rupees(preview.creditNote.tax)}` : `no GST (${preview.creditNote.treatment === "non_gst" ? "non-GST supply" : "exempt supply"}), value ${rupees(preview.creditNote.exemptValue)}`}. Provider: {preview.providerImpact.label}</p>}
        <label>Reason (at least 10 characters)<br /><textarea value={reason} onChange={event => setReason(event.target.value)} rows={2} style={{ width: "100%" }} /></label>
        <label>Note for the customer (optional)<br /><input value={customerNote} onChange={event => setCustomerNote(event.target.value)} maxLength={500} style={{ width: "100%" }} /></label>
        <div><button disabled={!ready} onClick={() => void submit()}>{busy ? "Sending…" : live ? `Ask Finance to refund ${rupees(live.amount)}` : "Ask Finance to refund"}</button></div>
      </div>}
      {loaded && loaded.requests.length > 0 && <ul style={{ margin: "12px 0 0", paddingLeft: 18 }}>{loaded.requests.map(row => <li key={row.id}><b>{rupees(row.amount)}</b> ({row.percent}%) · {requestStatus(row)} · asked by {row.requested_by}<br /><small style={{ color: "var(--staff-muted, #555)" }}>{row.reason}</small></li>)}</ul>}
    </>}
  </section>;
}
