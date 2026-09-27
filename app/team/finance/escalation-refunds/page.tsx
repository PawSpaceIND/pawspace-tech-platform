"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import StaffModule from "../../../components/staff-workspace/StaffModule";

/*
 * Finance > Escalation refunds: refunds after completion (owner decision D, 27 Sept 2026). Operations asks from the Booking Command Center;
 * a different person with finance.manage approves or rejects here. Approval refunds the customer's original payment
 * (sandbox), then the credit note, the TCS base and the provider payout follow once the gateway has processed it.
 */
type Refund = { id: string; amount: number; status: string; purpose: string | null; reason: string };
type Preview = { amount: number; asked: number; capped: boolean; creditNote: { treatment: string; taxableValue: number; exemptValue: number; tax: number; pendingInvoice: boolean }; providerImpact: { stage: string; providerShare: number; label: string } };
type Position = { refusal: string | null; booking: { id: string; serviceCode: string; packageName: string; customerName: string; providerName: string; status: string }; payment: { amountPaid: number; captured: number; refundedSoFar: number; pendingRequests: number; refundable: number }; refunds: Refund[]; invoice: { number: string; date: string } | null; preview: Preview | null };
type Pending = { id: string; booking_id: string; percent: number; amount: number; reason: string; customer_note: string | null; requested_by: string; requested_at: number; capped: number; position: Position };
type Recent = { id: string; booking_id: string; percent: number; amount: number; status: string; decided_by: string | null; decision_reason: string | null; case_status: string | null; credit_note_number: string | null; settlement_status: string | null; settlement_error: string | null; tcs_outcome: string | null; providerImpactLabel: string | null };
type CreditNote = { id: string; credit_note_number: string; issue_date: string; booking_id: string; customerName: string; original_invoice_number: string; treatment: string; refund_amount: number; value_reduced: number; taxable_value: number; exempt_value: number; cgst: number; sgst: number; igst: number; tax_total: number; gstr1_section: string; printPath: string };
type Queue = { pending: Pending[]; recent: Recent[]; creditNotes: CreditNote[] };

const rupees = (value: unknown) => `₹${Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (value: unknown) => value ? new Date(Number(value)).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "Not known";
const SECTION: Record<string, string> = { cdnr: "GSTR-1 CDNR (registered customer)", cdnur: "GSTR-1 CDNUR (B2C Large)", b2cs: "GSTR-1 B2CS reduced", nil: "GSTR-1 Table 8 reduced" };
const card = { background: "var(--staff-surface)", border: "1px solid var(--staff-line)", borderRadius: "calc(14px * var(--paw-radius-scale))", marginBottom: 14 };
function outcome(row: Recent) {
  if (row.status === "rejected") return `Rejected by ${row.decided_by}: ${row.decision_reason}`;
  if (row.status === "processed") return `Refunded · credit note ${row.credit_note_number || "not issued"}${row.tcs_outcome === "tcs_base_reduced" ? " · TCS base reduced" : ""}`;
  if (row.case_status === "failed") return "Approved, but the gateway refund failed: retry it from Booking operations";
  if (row.settlement_status === "pending") return `Refunded; still to finish: ${row.settlement_error || "credit note or payout step"}`;
  return row.case_status === "processing" ? "Approved and sent to the payment gateway" : "Approved, waiting for the payment gateway";
}

export default function EscalationRefundsPage() {
  const [queue, setQueue] = useState<Queue>({ pending: [], recent: [], creditNotes: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [rejectReasons, setRejectReasons] = useState<Record<string, string>>({});
  const read = useCallback(async () => { const response = await fetch("/api/escalation-refunds", { cache: "no-store" }); const body = await response.json().catch(() => ({})) as { data?: Queue; error?: string }; if (!response.ok || !body.data) throw new Error(body.error || "Refunds after completion are unavailable"); return body.data; }, []);
  useEffect(() => { let active = true; void read().then(data => { if (active) setQueue(data); }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "Refunds after completion are unavailable"); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [read]);
  async function decide(requestId: string, action: "approve" | "reject") {
    setBusy(requestId); setError(""); setNotice("");
    try {
      const response = await fetch("/api/escalation-refunds", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, requestId, reason: action === "reject" ? (rejectReasons[requestId] || "").trim() : undefined }) });
      const body = await response.json().catch(() => ({})) as { error?: string; data?: { execution?: { initiated?: number; errors?: string[] } } };
      if (!response.ok) throw new Error(body.error || "The decision was not saved");
      const sent = Number(body.data?.execution?.initiated || 0) > 0;
      setNotice(action === "approve" ? (sent ? "Approved. The refund was sent to the customer's original payment method." : `Approved. The refund goes to the payment gateway on the next run${body.data?.execution?.errors?.length ? ` (${body.data.execution.errors.join("; ")})` : ""}.`) : "Rejected. Nothing was refunded.");
      setQueue(await read());
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The decision was not saved"); }
    finally { setBusy(""); }
  }

  return <StaffModule><main style={{ minHeight: "100vh", background: "var(--staff-bg)", padding: 28, color: "var(--staff-text)" }}><div style={{ maxWidth: 1300, margin: "0 auto" }}>
    <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 15, marginBottom: 18, flexWrap: "wrap" }}><div><small style={{ fontWeight: 800, color: "var(--paw-link)" }}>PAWSPACE FINANCE · ESCALATION REFUNDS</small><h1 style={{ margin: "7px 0" }}>Escalation refunds and credit notes</h1><p style={{ margin: 0, color: "var(--staff-muted)" }}>Refunds after completion. Operations asks for a percentage of what the customer paid. Someone other than the person who asked approves it here; the refund goes back to the original payment method, PawSpace issues a credit note for its own share, and the provider&apos;s share comes off their payout.</p></div><Link href="/team/finance" style={{ padding: 10, background: "var(--staff-primary)", color: "var(--staff-on-primary)", borderRadius: "calc(10px * var(--paw-radius-scale))", textDecoration: "none" }}>Finance home</Link></header>
    {error && <div role="alert" style={{ padding: 12, background: "var(--staff-danger-bg)", borderRadius: "calc(10px * var(--paw-radius-scale))", marginBottom: 12 }}>{error}</div>}
    {notice && <div role="status" style={{ padding: 12, background: "var(--staff-surface)", border: "1px solid var(--staff-line)", borderRadius: "calc(10px * var(--paw-radius-scale))", marginBottom: 12 }}>{notice}</div>}
    <section style={card} aria-label="Waiting for approval"><div style={{ padding: 15, borderBottom: "1px solid var(--staff-line)" }}><b>Waiting for approval ({queue.pending.length})</b></div>
      {loading ? <p style={{ padding: 18 }}>Loading…</p> : queue.pending.length === 0 ? <p style={{ padding: 18, color: "var(--staff-muted)" }}>No refund after completion is waiting.</p> : queue.pending.map(row => { const p = row.position, preview = p.preview; return <article key={row.id} style={{ padding: 15, borderBottom: "1px solid var(--staff-line)", display: "grid", gap: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}><strong>{row.booking_id} · {p.booking.serviceCode.replaceAll("_", " ")} · {p.booking.packageName}</strong><span>Asked by {row.requested_by} · {when(row.requested_at)}</span></div>
        <span>Customer {p.booking.customerName || "not recorded"} · provider {p.booking.providerName || "not recorded"}</span>
        <span>Paid <b>{rupees(p.payment.amountPaid)}</b> · refunds so far <b>{rupees(p.payment.refundedSoFar)}</b>{p.refunds.length ? ` (${p.refunds.map(r => `${rupees(r.amount)} ${r.status}`).join(", ")})` : ""} · still refundable <b>{rupees(p.payment.refundable)}</b></span>
        <span>Refund <b>{row.percent}%</b> = <b>{rupees(row.amount)}</b>{row.capped ? " (capped at what was refundable)" : ""}</span>
        <span>Reason: {row.reason}{row.customer_note ? ` · note for the customer: ${row.customer_note}` : ""}</span>
        {preview && <span>Credit note: {preview.creditNote.tax > 0 ? `taxable value ${rupees(preview.creditNote.taxableValue)}, GST ${rupees(preview.creditNote.tax)}` : `no GST, value ${rupees(preview.creditNote.exemptValue)}`}{p.invoice ? ` against invoice ${p.invoice.number}` : " (issued once the customer invoice exists)"} · Provider: {preview.providerImpact.label}</span>}
        {p.refusal && <span style={{ fontWeight: 700 }}>{p.refusal}</span>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}><button disabled={Boolean(busy)} onClick={() => void decide(row.id, "approve")}>{busy === row.id ? "Working…" : `Approve ${rupees(row.amount)} refund`}</button><input style={{ flex: "1 1 240px" }} placeholder="Reason to reject (at least 10 characters)" value={rejectReasons[row.id] || ""} onChange={event => setRejectReasons(current => ({ ...current, [row.id]: event.target.value }))} /><button disabled={Boolean(busy) || (rejectReasons[row.id] || "").trim().length < 10} onClick={() => void decide(row.id, "reject")}>Reject</button></div>
      </article>; })}
    </section>
    <section style={card} aria-label="Recent decisions"><div style={{ padding: 15, borderBottom: "1px solid var(--staff-line)" }}><b>Recent decisions</b></div>
      {queue.recent.length === 0 ? <p style={{ padding: 18, color: "var(--staff-muted)" }}>No decisions yet.</p> : queue.recent.map(row => <article key={row.id} style={{ padding: 12, borderBottom: "1px solid var(--staff-line)" }}><b>{row.booking_id}</b> · {row.percent}% = {rupees(row.amount)} · {outcome(row)}{row.providerImpactLabel ? <small style={{ display: "block", color: "var(--staff-muted)" }}>Provider: {row.providerImpactLabel}</small> : null}</article>)}
    </section>
    <section style={{ ...card, overflow: "hidden" }} aria-label="Credit notes"><div style={{ padding: 15, borderBottom: "1px solid var(--staff-line)" }}><b>Credit notes</b><small style={{ display: "block", color: "var(--staff-muted)" }}>One per refund after completion, issued against the customer&apos;s invoice for PawSpace&apos;s own share only.</small></div>
      {queue.creditNotes.length === 0 ? <p style={{ padding: 18, color: "var(--staff-muted)" }}>No credit notes yet.</p> : <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}><thead><tr>{["Credit note", "Date", "Booking", "Customer", "Original invoice", "Refund", "Value reduced", "GST reduced", "Return", ""].map(h => <th key={h} style={{ textAlign: "left", padding: 10, borderBottom: "1px solid var(--staff-line)" }}>{h}</th>)}</tr></thead><tbody>
        {queue.creditNotes.map(note => <tr key={note.id}><td style={{ padding: 10 }}><b>{note.credit_note_number}</b></td><td style={{ padding: 10 }}>{note.issue_date}</td><td style={{ padding: 10 }}>{note.booking_id}</td><td style={{ padding: 10 }}>{note.customerName}</td><td style={{ padding: 10 }}>{note.original_invoice_number}</td><td style={{ padding: 10 }}>{rupees(note.refund_amount)}</td><td style={{ padding: 10 }}>{rupees(note.value_reduced)}</td><td style={{ padding: 10 }}>{Number(note.tax_total) > 0 ? `${rupees(note.tax_total)} (${Number(note.igst) > 0 ? `IGST ${rupees(note.igst)}` : `CGST ${rupees(note.cgst)} + SGST ${rupees(note.sgst)}`})` : "No GST"}</td><td style={{ padding: 10 }}>{SECTION[note.gstr1_section] || note.gstr1_section}</td><td style={{ padding: 10 }}><a href={note.printPath} target="_blank" rel="noreferrer">Print</a></td></tr>)}
      </tbody></table></div>}
    </section>
  </div></main></StaffModule>;
}
