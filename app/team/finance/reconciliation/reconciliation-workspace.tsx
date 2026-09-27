"use client";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { readReportJson } from "../../../../lib/read-report-json";
import { financeServiceLabel } from "../../../../lib/finance-services";

type Exception = { id: string; bookingId: string | null; paymentId: string | null; eventId: string | null; type: string; severity: string; status: string; detail: Record<string, unknown>; createdAt: number; resolvedAt: number | null; resolvedBy: string | null };
type AttentionRecord = { paymentId: string; bookingId: string; serviceCode: string | null; packageName: string | null; bookingStatus: string | null; expectedAmount: number; capturedAmount: number; refundedAmount: number; gatewayStatus: string; reconciliationStatus: string; varianceAmount: number; updatedAt: number };
type StuckWebhook = { id: string; eventId: string; eventType: string; environment: string; status: string; failureReason: string | null; receivedAt: number; gatewayOrderId: string | null; gatewayPaymentId: string | null; amount: number | null; claimedBookingId: string | null; captureRecorded: boolean };
type PendingEffect = { id: string; status: string; attempts: number; lastError: string | null; createdAt: number; nextAttemptAt: number; bookingId: string | null; gatewayPaymentId: string | null; amount: number | null };
export type ReconciliationOverview = {
  generatedAt: number;
  summary: { openExceptions: number; criticalExceptions: number; overCollected: number; refundOverage: number; needsAttention: number; stuckWebhooks: number; uncountedCaptures: number; pendingCaptureEffects: number };
  exceptions: Exception[]; records: AttentionRecord[]; stuckCaptures: { webhooks: StuckWebhook[]; effects: PendingEffect[] };
};

const money = (value: unknown) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(value || 0));
const label = (value: unknown) => String(value || "").replaceAll("_", " ");
const when = (ms: number) => (ms ? new Date(ms).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }) : "—");
const cell = { padding: "10px 12px", borderBottom: "1px solid var(--staff-line)", verticalAlign: "top" } as const;
const box = { background: "var(--staff-surface)", border: "1px solid var(--staff-line)", borderRadius: 14, overflow: "hidden", marginBottom: 20 } as const;

const EXCEPTION_TYPES: Record<string, string> = {
  over_collection: "Over-collection (paid more than the booking value)",
  refund_overage: "Refund above the money collected",
  unmatched_gateway_capture: "Capture no booking payment owns",
  unmatched_gateway_event: "Gateway event with no booking",
  gateway_order_booking_mismatch: "Capture names a different booking",
  capture_amount_mismatch: "Capture amount does not match the order",
  currency_mismatch: "Currency mismatch",
  orphan_gateway_refund: "Gateway refund with no refund case",
  refund_amount_mismatch: "Refund amount does not match the case",
  refund_failed: "Refund failed at the gateway",
};
export const exceptionTypeLabel = (type: string) => EXCEPTION_TYPES[type] ?? label(type);

/** The amounts an exception carries, in words (over-collection excess, refund overage, the refused capture's amount). */
export function exceptionAmounts(detail: Record<string, unknown>) {
  const parts: string[] = [];
  const add = (name: string, key: string) => { if (detail[key] != null && detail[key] !== "") parts.push(`${name} ${money(detail[key])}`); };
  add("booking value", "bookingValue"); add("captured", "capturedAmount"); add("excess", "excessAmount");
  add("expected", "expected"); add("captured", "captured"); add("refunded", "refunded"); add("amount", "amount"); add("received", "received"); add("variance", "variance");
  for (const key of ["gatewayOrderId", "gatewayPaymentId", "gatewayRefundId", "claimedBookingId", "linkedBookingId"]) if (detail[key]) parts.push(`${label(key.replace(/([A-Z])/g, "_$1").toLowerCase())} ${String(detail[key])}`);
  return parts.join(" · ") || "—";
}

function Stat({ name, value, alert }: { name: string; value: number; alert?: boolean }) {
  return <article style={{ background: "var(--staff-surface)", border: "1px solid var(--staff-line)", borderRadius: 14, padding: 18 }}><small style={{ color: "var(--staff-muted)" }}>{name}</small><strong style={{ display: "block", fontSize: 25, marginTop: 7, color: alert && value > 0 ? "var(--staff-danger)" : undefined }}>{value}</strong></article>;
}
function Table({ title, headings, empty, children, count }: { title: string; headings: string[]; empty: string; children: ReactNode; count: number }) {
  return <section style={box}><div style={{ padding: "14px 18px", borderBottom: "1px solid var(--staff-line)" }}><b>{title}</b> <small style={{ color: "var(--staff-muted)" }}>({count})</small></div>
    <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 15 }}><thead><tr>{headings.map(h => <th key={h} style={{ ...cell, textAlign: "left", background: "var(--staff-raised)", whiteSpace: "nowrap" }}>{h}</th>)}</tr></thead>
      <tbody>{count === 0 ? <tr><td colSpan={headings.length} style={{ padding: 24, textAlign: "center", color: "var(--staff-muted)" }}>{empty}</td></tr> : children}</tbody></table></div></section>;
}
const bookingLink = (bookingId: string | null) => bookingId ? <Link href={`/team/operations/bookings?bookingId=${encodeURIComponent(bookingId)}`} style={{ color: "var(--staff-primary)", fontWeight: 700 }}>{bookingId}</Link> : "—";

/** Read-only: what Finance has to clear, as GET /api/payment-reconciliation?view=overview reports it. */
export function PaymentReconciliationView({ data, status, onStatus, loading, error }: { data: ReconciliationOverview | null; status: string; onStatus: (status: string) => void; loading: boolean; error: string }) {
  return <>
    <nav aria-label="Exception status" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
      {[["open", "Open"], ["investigating", "Investigating"], ["all", "All"]].map(([value, name]) => <button key={value} type="button" aria-pressed={status === value} disabled={loading} onClick={() => onStatus(value)}
        style={{ padding: "8px 14px", borderRadius: 999, border: "1px solid var(--staff-line)", background: status === value ? "var(--staff-primary)" : "var(--staff-surface)", color: status === value ? "var(--staff-on-primary)" : "var(--staff-text)", fontWeight: 700 }}>{name}</button>)}
    </nav>
    {error && <section role="alert" style={{ padding: 18, borderRadius: 12, background: "var(--staff-danger-bg)", border: "1px solid var(--staff-line)", marginBottom: 20 }}><b>Reconciliation unavailable</b><div>{error}</div></section>}
    {loading && <section style={{ padding: 24, background: "var(--staff-surface)", borderRadius: 14 }}>Loading payment exceptions and reconciliation…</section>}
    {data && !loading && !error && <>
      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 12, marginBottom: 20 }} data-staff-grid="stats">
        <Stat name="Open exceptions" value={data.summary.openExceptions} alert /><Stat name="Critical" value={data.summary.criticalExceptions} alert />
        <Stat name="Over-collected bookings" value={data.summary.overCollected} alert /><Stat name="Refund overages" value={data.summary.refundOverage} alert />
        <Stat name="Stuck capture webhooks" value={data.summary.stuckWebhooks} alert /><Stat name="Captures not yet counted" value={data.summary.uncountedCaptures} alert />
        <Stat name="Capture follow-up pending" value={data.summary.pendingCaptureEffects} alert />
      </section>
      <Table title="Payment exceptions" count={data.exceptions.length} empty={`No ${status === "all" ? "" : `${status} `}payment exceptions.`} headings={["Raised", "Exception", "Severity", "Booking", "Payment", "Amounts", "Status"]}>
        {data.exceptions.map(item => <tr key={item.id} data-exception-id={item.id}><td style={cell}>{when(item.createdAt)}</td><td style={{ ...cell, fontWeight: 700 }}>{exceptionTypeLabel(item.type)}</td><td style={cell}>{label(item.severity)}</td><td style={cell}>{bookingLink(item.bookingId)}</td><td style={cell}>{item.paymentId || "—"}</td><td style={cell}>{exceptionAmounts(item.detail)}</td><td style={cell}>{label(item.status)}{item.resolvedBy ? ` by ${item.resolvedBy}` : ""}</td></tr>)}
      </Table>
      <Table title="Reconciliation needing attention" count={data.records.length} empty="Every reconciliation record is matched or in progress." headings={["Booking", "Service", "Reconciliation", "Expected", "Captured", "Refunded", "Variance", "Updated"]}>
        {data.records.map(row => <tr key={row.paymentId} data-payment-id={row.paymentId}><td style={cell}>{bookingLink(row.bookingId)}</td><td style={cell}>{row.serviceCode ? financeServiceLabel(row.serviceCode) : "—"}</td><td style={{ ...cell, fontWeight: 700 }}>{label(row.reconciliationStatus)}</td><td style={cell}>{money(row.expectedAmount)}</td><td style={cell}>{money(row.capturedAmount)}</td><td style={cell}>{money(row.refundedAmount)}</td><td style={cell}>{money(row.varianceAmount)}</td><td style={cell}>{when(row.updatedAt)}</td></tr>)}
      </Table>
      <Table title="Captures stuck in the webhook inbox" count={data.stuckCaptures.webhooks.length} empty="No capture webhook is failed, deferred or stuck." headings={["Received", "Event", "Status", "Reason", "Order / payment", "Amount", "Booking named", "Capture counted"]}>
        {data.stuckCaptures.webhooks.map(row => <tr key={row.id} data-webhook-event={row.eventId}><td style={cell}>{when(row.receivedAt)}</td><td style={cell}>{row.eventType}<small style={{ display: "block", color: "var(--staff-muted)" }}>{row.eventId}</small></td><td style={{ ...cell, fontWeight: 700 }}>{row.status}</td><td style={cell}>{row.failureReason ? label(row.failureReason) : "no reason recorded"}</td><td style={cell}>{row.gatewayOrderId || "—"}<small style={{ display: "block", color: "var(--staff-muted)" }}>{row.gatewayPaymentId || ""}</small></td><td style={cell}>{row.amount == null ? "—" : money(row.amount)}</td><td style={cell}>{bookingLink(row.claimedBookingId)}</td><td style={cell}>{row.captureRecorded ? "Yes, through another notification" : <strong style={{ color: "var(--staff-danger)" }}>No, not in the books</strong>}</td></tr>)}
      </Table>
      <Table title="Captured payments whose follow-up has not finished" count={data.stuckCaptures.effects.length} empty="Every verified capture finished its collection posting and confirmation." headings={["Captured", "Booking", "Payment", "Amount", "Status", "Attempts", "Last error"]}>
        {data.stuckCaptures.effects.map(row => <tr key={row.id}><td style={cell}>{when(row.createdAt)}</td><td style={cell}>{bookingLink(row.bookingId)}</td><td style={cell}>{row.gatewayPaymentId || "—"}</td><td style={cell}>{row.amount == null ? "—" : money(row.amount)}</td><td style={{ ...cell, fontWeight: 700 }}>{label(row.status)}</td><td style={cell}>{row.attempts}</td><td style={cell}>{row.lastError || "—"}</td></tr>)}
      </Table>
      <p style={{ fontSize: 14, color: "var(--staff-muted)" }}>Read-only. Refunds go through each service&apos;s Finance workspace; an exception is resolved through the governed payment-exception resolution. Figures as of {when(data.generatedAt)}.</p>
    </>}
  </>;
}

export default function ReconciliationWorkspace() {
  const [status, setStatus] = useState("open");
  const [data, setData] = useState<ReconciliationOverview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const read = async (next: string) => { const body = await readReportJson<{ data?: ReconciliationOverview }>(`/api/payment-reconciliation?view=overview&status=${encodeURIComponent(next)}`); if (!body.data?.summary || !Array.isArray(body.data.exceptions)) throw new Error("Reconciliation response is incomplete"); return body.data; };
  const load = async (next = status) => { setLoading(true); setError(""); try { setData(await read(next)); } catch (err) { setData(null); setError(err instanceof Error ? err.message : "Unable to load reconciliation"); } finally { setLoading(false); } };
  useEffect(() => { let active = true; read("open").then(body => { if (active) setData(body); }).catch(err => { if (active) setError(err instanceof Error ? err.message : "Unable to load reconciliation"); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, []);
  return <main style={{ minHeight: "100vh", background: "var(--staff-bg)", padding: "32px", color: "var(--staff-text)" }}>
    <div style={{ maxWidth: 1420, margin: "0 auto" }}>
      <header style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 20, alignItems: "center", marginBottom: 24 }}>
        <div><small style={{ fontWeight: 800, letterSpacing: 1.4, color: "var(--staff-primary)" }}>PAWSPACE TEAM · FINANCE</small><h1 style={{ fontSize: 32, margin: "8px 0" }}>Payment reconciliation &amp; exceptions</h1><p style={{ margin: 0, color: "var(--staff-muted)" }}>Over-collections, refund overages, captures no booking owns and captures stuck before they reached the books, for every service.</p></div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}><button type="button" disabled={loading} onClick={() => void load()} style={{ padding: "11px 16px", borderRadius: 10, border: "1px solid var(--staff-line)", background: "var(--staff-surface)", fontWeight: 700 }}>Refresh</button><Link href="/team/finance" style={{ padding: "11px 16px", borderRadius: 10, background: "var(--staff-primary)", color: "var(--staff-on-primary)", textDecoration: "none", fontWeight: 700 }}>Finance home</Link></div>
      </header>
      <PaymentReconciliationView data={data} status={status} onStatus={next => { setStatus(next); void load(next); }} loading={loading} error={error} />
    </div>
  </main>;
}
