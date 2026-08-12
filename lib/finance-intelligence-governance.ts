/**
 * Finance intelligence - controls & forward view over the ledger we already keep.
 *
 *   detectFinanceAnomalies - scans the journal and vendor bills for things a controller would want to
 *     see: unbalanced journals (a data-integrity red flag), likely duplicate bills, and outlier bills
 *     far above a vendor's own history. Findings are advisory - nothing is auto-reversed or blocked.
 *   forecastCashFlow - projects cash forward from the trailing monthly net cash movement, extending
 *     the cash-flow statement into a simple, explainable runway view.
 *
 * Rules/statistics today (no external provider needed); cold-DB safe.
 */

import { ACCT } from "./finance-accounts";

type Db = D1Database;
type Row = Record<string, unknown>;
const empty = () => ({ results: [] as Row[] });
const round2 = (n: number) => Math.round(n * 100) / 100;
const DUP_WINDOW_DAYS = 7;
const OUTLIER_MULTIPLE = 3;
const nextPeriod = (p: string) => { let [y, m] = p.split("-").map(Number); m++; if (m > 12) { m = 1; y++; } return `${y}-${String(m).padStart(2, "0")}`; };

/** Detect ledger anomalies (unbalanced journals, duplicate bills, outlier bills). Advisory only. */
export async function detectFinanceAnomalies(db: Db, input: { periodCode?: string } = {}) {
  const period = String(input.periodCode || "").trim();
  const anomalies: Array<Record<string, unknown>> = [];

  // 1) unbalanced journals - group lines by their journal group (id without the trailing -N)
  const jrn = await db.prepare(`SELECT id,debit,credit,period_code,narration FROM finance_journal_entries${period ? " WHERE period_code=?" : ""}`).bind(...(period ? [period] : [])).all<Row>().catch(empty);
  const groups = new Map<string, { debit: number; credit: number; period: string; narration: string }>();
  for (const r of jrn.results) {
    const g = String(r.id).replace(/-\d+$/, "");
    const cur = groups.get(g) || { debit: 0, credit: 0, period: String(r.period_code), narration: String(r.narration) };
    cur.debit += Number(r.debit) || 0; cur.credit += Number(r.credit) || 0;
    groups.set(g, cur);
  }
  for (const [g, v] of groups) {
    const diff = round2(v.debit - v.credit);
    if (Math.abs(diff) > 0.01) anomalies.push({ type: "unbalanced_journal", severity: "high", subjectId: g, period: v.period, detail: `Debit ${round2(v.debit)} != credit ${round2(v.credit)} (out by ${diff})`, narration: v.narration });
  }

  // 2) duplicate + outlier vendor bills
  const bills = await db.prepare(`SELECT id,vendor_id,bill_number,bill_date,total_amount FROM finance_bills${period ? " WHERE substr(bill_date,1,7)=?" : ""} ORDER BY vendor_id,bill_date`).bind(...(period ? [period] : [])).all<Row>().catch(empty);
  const byVendor = new Map<string, Row[]>();
  for (const b of bills.results) { const v = String(b.vendor_id); (byVendor.get(v) || byVendor.set(v, []).get(v)!).push(b); }
  for (const [vendor, list] of byVendor) {
    // duplicates: same vendor + same amount within the window
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      if (round2(Number(list[i].total_amount)) !== round2(Number(list[j].total_amount))) continue;
      const di = Date.parse(String(list[i].bill_date)), dj = Date.parse(String(list[j].bill_date));
      if (Number.isNaN(di) || Number.isNaN(dj) || Math.abs(di - dj) > DUP_WINDOW_DAYS * 86_400_000) continue;
      anomalies.push({ type: "duplicate_bill", severity: "medium", subjectId: String(list[j].id), vendorId: vendor, detail: `Same amount Rs.${round2(Number(list[j].total_amount))} as bill ${String(list[i].bill_number)} within ${DUP_WINDOW_DAYS} days` });
    }
    // outliers: a bill far above this vendor's OTHER bills (leave-one-out, so the outlier can't inflate its own baseline)
    if (list.length >= 3) {
      const total = list.reduce((s, b) => s + Number(b.total_amount), 0);
      for (const b of list) {
        const othersAvg = (total - Number(b.total_amount)) / (list.length - 1);
        if (othersAvg > 0 && Number(b.total_amount) > othersAvg * OUTLIER_MULTIPLE) anomalies.push({ type: "outlier_bill", severity: "medium", subjectId: String(b.id), vendorId: vendor, detail: `Rs.${round2(Number(b.total_amount))} is ${round2(Number(b.total_amount) / othersAvg)}x this vendor's usual bill (Rs.${round2(othersAvg)})` });
      }
    }
  }
  const order = { high: 0, medium: 1, low: 2 } as Record<string, number>;
  anomalies.sort((a, b) => (order[String(a.severity)] ?? 3) - (order[String(b.severity)] ?? 3));
  return { periodCode: period || "all", anomalyCount: anomalies.length, anomalies };
}

/** Project cash forward from the trailing monthly net cash movement. Extends the cash-flow statement. */
export async function forecastCashFlow(db: Db, input: { months?: number; trailingMonths?: number } = {}) {
  const months = Math.max(1, Math.min(Number(input.months) || 3, 12));
  const trailingWindow = Math.max(1, Math.min(Number(input.trailingMonths) || 6, 24));
  const rows = await db.prepare("SELECT period_code period,ROUND(SUM(debit-credit),2) net FROM finance_journal_entries WHERE account_code IN (?,?) GROUP BY period_code ORDER BY period_code").bind(ACCT.CASH, ACCT.BANK).all<Row>().catch(empty);
  const actual = rows.results.map(r => ({ period: String(r.period), net: round2(Number(r.net)) }));
  let closing = 0;
  for (const a of actual) closing = round2(closing + a.net); // cumulative closing through the latest actual period
  const latestPeriod = actual.length ? actual[actual.length - 1].period : new Date().toISOString().slice(0, 7);
  const window = actual.slice(-trailingWindow);
  const trailingMonthlyNet = window.length ? round2(window.reduce((s, a) => s + a.net, 0) / window.length) : 0;
  const forecast = [];
  let period = latestPeriod, projected = closing;
  for (let i = 0; i < months; i++) { period = nextPeriod(period); projected = round2(projected + trailingMonthlyNet); forecast.push({ period, projectedNet: trailingMonthlyNet, projectedClosingCash: projected }); }
  return { method: "trailing_net_projection_v1", basisPeriods: actual.length, latestPeriod, latestClosingCash: closing, trailingMonthlyNet, months, forecast, runwayNote: trailingMonthlyNet < 0 ? "net cash is trending down - projection shows the burn runway" : "net cash is stable or growing" };
}
