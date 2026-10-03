"use client";
import styles from "./finance-content.module.css";
import Link from "next/link";
import { FINANCE_SERVICES, financeServiceLabel } from "../../../lib/finance-services";

/** One booking's payment state, as GET /api/payment-reconciliation?view=bookings returns it. */
export type FinanceLedgerItem = {
  bookingId: string; serviceCode: string; packageName: string; bookingStatus: string; scheduledStart: string | null; bookingTotal: number;
  paymentId: string | null; paymentStatus: string | null; paymentMode: string | null; amountDueNow: number | null;
  scheduleStatus: string | null; balanceAmount: number | null; capturedAmount: number | null; refundedAmount: number | null; netCollected: number | null;
  gatewayStatus: string | null; reconciliationStatus: string | null; varianceAmount: number | null; openExceptions: number; invoiceNumber: string | null;
};
export type FinanceLedgerService = { code: string; label: string; workspace: string | null; bookings: number; paidBookings: number; captured: number; refunded: number; attention: number };
export type FinanceLedgerData = { services: FinanceLedgerService[]; items: FinanceLedgerItem[]; openExceptions: number; limit: number };

const money = (value: unknown) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(value || 0));
const label = (value: unknown, fallback = "not started") => String(value || fallback).replaceAll("_", " ");
const cell = { padding: "12px", borderBottom: "1px solid var(--staff-line)", verticalAlign: "top" } as const;
const card = { background: "var(--staff-surface)", border: "1px solid var(--staff-line)", borderRadius: "calc(14px * var(--paw-radius-scale))", padding: 18 } as const;
const ATTENTION = new Set(["over_collected", "refund_overage", "amount_mismatch", "exception", "pending_refund"]);

/** Where Finance acts on one booking of this service, if it has a workspace. */
export function bookingWorkspaceHref(item: Pick<FinanceLedgerItem, "serviceCode" | "bookingId">) {
  const workspace = FINANCE_SERVICES.find(service => service.code === item.serviceCode)?.workspace;
  if (!workspace) return null;
  return item.serviceCode === "dog_training" ? workspace : `${workspace}?bookingId=${encodeURIComponent(item.bookingId)}`;
}

const MODES: Record<string, string> = { prepaid: "prepaid", split_50_50: "50/50 split", pay_after_service: "pay after service" };
/** What a split stay's or a ride's booking-fee schedule still owes. */
function scheduleText(status: string, balance: number | null) {
  if (status === "paid") return "paid in full";
  if (status === "booking_fee_pending") return "booking fee due";
  if (status === "pending_balance" || status === "booking_fee_paid") return `balance ${money(balance)} due`;
  if (status === "overdue") return `balance ${money(balance)} overdue`;
  return `schedule ${label(status)}`;
}
/** The payment state in words: status, how it is paid, and what the split or booking-fee schedule still owes. */
export function paymentStateText(item: FinanceLedgerItem) {
  if (!item.paymentStatus) return "No payment record";
  const parts = [label(item.paymentStatus)];
  if (item.paymentMode) parts.push(MODES[item.paymentMode] ?? label(item.paymentMode));
  if (item.scheduleStatus) parts.push(scheduleText(item.scheduleStatus, item.balanceAmount));
  return parts.join(" · ");
}

/** Every service's bookings and their payment state. Read-only: actions live in each service's workspace. */
export function FinanceLedger({ data, loading, service, onService }: { data: FinanceLedgerData | null; loading: boolean; service: string; onService: (code: string) => void }) {
  const shown = data?.services ?? [];
  const totals = shown.reduce((acc, row) => ({ bookings: acc.bookings + row.bookings, paid: acc.paid + row.paidBookings, captured: acc.captured + row.captured, refunded: acc.refunded + row.refunded, attention: acc.attention + row.attention }), { bookings: 0, paid: 0, captured: 0, refunded: 0, attention: 0 });
  return <div className={styles.ledger}>
    <nav className={styles.filters} aria-label="Service" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
      {[{ code: "", label: "All services" }, ...FINANCE_SERVICES].map(option => <button key={option.code || "all"} type="button" aria-pressed={service === option.code} disabled={loading} onClick={() => onService(option.code)}
        style={{ padding: "8px 14px", borderRadius: 999, border: "1px solid var(--staff-line)", background: service === option.code ? "var(--staff-primary)" : "var(--staff-surface)", color: service === option.code ? "var(--staff-on-primary)" : "var(--staff-text)", fontWeight: 700 }}>{option.label}</button>)}
    </nav>
    {loading && <section style={{ padding: 24, background: "var(--staff-surface)", borderRadius: "calc(14px * var(--paw-radius-scale))", marginBottom: 12 }}>Loading bookings across services…</section>}
    {data && !loading && <>
      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 12, marginBottom: 12 }} className={styles.metrics} data-staff-grid="stats">
        {[["Bookings", totals.bookings], ["Paid bookings", totals.paid], ["Captured", money(totals.captured)], ["Refunded", money(totals.refunded)], ["Net collected", money(Math.max(0, totals.captured - totals.refunded))], ["Need reconciliation", totals.attention]].map(([name, value]) =>
          <article className={styles.metric} key={String(name)} style={card}><small style={{ color: "var(--staff-muted)" }}>{name}</small><strong style={{ display: "block", fontSize: 23, marginTop: 7 }}>{value}</strong></article>)}
      </section>
      {data.openExceptions > 0 && <section className={styles.exceptions} role="status" style={{ padding: 16, borderRadius: "calc(12px * var(--paw-radius-scale))", background: "var(--staff-warning-bg)", border: "1px solid var(--staff-line)", marginBottom: 18 }}>
        <b>{data.openExceptions} open payment exception(s) need Finance review.</b> <Link href="/team/finance/reconciliation" style={{ color: "var(--paw-link)", fontWeight: 700 }}>Open reconciliation &amp; exceptions</Link>
      </section>}
      <section className={styles.tableCard} style={{ ...card, padding: 0, overflow: "hidden", marginBottom: 18 }}>
        <div style={{ padding: "16px 18px", borderBottom: "1px solid var(--staff-line)" }}><b>By service</b></div>
        <div className={styles.tableRegion} role="region" aria-label="By service; scroll horizontally for all columns" tabIndex={0} style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 15 }}><thead><tr>{["Service", "Bookings", "Paid", "Captured", "Refunded", "Need reconciliation"].map(h => <th key={h} style={{ ...cell, textAlign: "left", background: "var(--staff-raised)", whiteSpace: "nowrap" }}>{h}</th>)}</tr></thead><tbody>
          {shown.map(row => <tr key={row.code}><td style={{ ...cell, fontWeight: 700 }}>{row.workspace ? <Link href={row.workspace} style={{ color: "var(--paw-link)" }}>{row.label}</Link> : row.label}</td><td style={cell}>{row.bookings}</td><td style={cell}>{row.paidBookings}</td><td style={cell}>{money(row.captured)}</td><td style={cell}>{money(row.refunded)}</td><td style={cell}>{row.attention}</td></tr>)}
        </tbody></table></div>
      </section>
      <section className={styles.tableCard} style={{ ...card, padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "16px 18px", borderBottom: "1px solid var(--staff-line)", display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}><b>Bookings and their payment state</b><small>Newest {data.items.length} of {totals.bookings}{service ? ` · ${financeServiceLabel(service)}` : " · all services"}</small></div>
        <div className={styles.tableRegion} role="region" aria-label="Bookings and their payment state; scroll horizontally for all columns" tabIndex={0} style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 15 }}><thead><tr>{["Booking", "Service", "Package", "Booking status", "Payment", "Booking total", "Captured", "Refunded", "Reconciliation", "Variance", "Invoice"].map(h => <th key={h} style={{ ...cell, textAlign: "left", background: "var(--staff-raised)", whiteSpace: "nowrap" }}>{h}</th>)}</tr></thead><tbody>
          {data.items.length === 0 && <tr><td colSpan={11} style={{ padding: 30, textAlign: "center", color: "var(--staff-muted)" }}>No bookings yet{service ? ` for ${financeServiceLabel(service)}` : ""}.</td></tr>}
          {data.items.map(item => {
            const href = bookingWorkspaceHref(item), flagged = ATTENTION.has(String(item.reconciliationStatus)) || item.openExceptions > 0;
            return <tr key={item.bookingId} data-booking-id={item.bookingId}>
              <td style={{ ...cell, fontWeight: 700, whiteSpace: "nowrap" }}>{href ? <Link href={href} style={{ color: "var(--paw-link)" }}>{item.bookingId}</Link> : item.bookingId}</td>
              <td style={cell}>{financeServiceLabel(item.serviceCode)}</td>
              <td style={cell}>{item.packageName}</td>
              <td style={cell}>{label(item.bookingStatus)}</td>
              <td style={cell}>{paymentStateText(item)}</td>
              <td style={cell}>{money(item.bookingTotal)}{item.amountDueNow != null && item.amountDueNow !== item.bookingTotal ? <small style={{ display: "block", color: "var(--staff-muted)" }}>due now {money(item.amountDueNow)}</small> : null}</td>
              <td style={cell}>{item.capturedAmount == null ? "—" : money(item.capturedAmount)}</td>
              <td style={cell}>{item.refundedAmount == null ? "—" : money(item.refundedAmount)}</td>
              <td style={cell}><strong style={flagged ? { color: "var(--staff-danger)" } : undefined}>{item.reconciliationStatus ? label(item.reconciliationStatus) : "no gateway record"}</strong>{item.openExceptions > 0 && <small style={{ display: "block", marginTop: 3 }}>{item.openExceptions} open exception(s)</small>}</td>
              <td style={cell}>{item.varianceAmount ? money(item.varianceAmount) : "—"}</td>
              <td style={cell}>{item.invoiceNumber || "Pending"}</td>
            </tr>;
          })}
        </tbody></table></div>
      </section>
    </>}
  </div>;
}
