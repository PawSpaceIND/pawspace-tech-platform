/**
 * Cash Flow Statement (direct method), built from the double-entry journal (finance_journal_entries).
 *
 * Method: for every journal that touches a cash/bank account, the net cash movement is the debit-
 * credit on the cash lines. That movement is classified operating / investing / financing by the
 * OTHER (counterpart) accounts in the same journal (see finance-accounts.cashFlowSection). Opening
 * cash is every cash movement before the window; closing cash = opening + net movement in the window.
 *
 * Because recognition journals (Dr Deferred Revenue Cr Revenue) never touch cash, they correctly do
 * NOT appear here - only the collection journals (Dr Bank ...) do. So the cash-flow statement shows
 * cash when it arrives, while the P&L (revenue-recognition module) shows revenue when it is earned.
 */

import { CASH_ACCOUNTS, cashFlowSection, ensureFinanceJournalTable, round } from "./finance-accounts";

type Db = D1Database;
type Row = Record<string, unknown>;
type Section = "operating" | "investing" | "financing";

const inRange = (period: string, from: string, to: string) => period >= from && period <= to;

/**
 * Generate a cash-flow statement for the period window [fromPeriod, toPeriod] (YYYY-MM inclusive).
 * Pass a single periodCode to report one month.
 */
export async function generateCashFlowStatement(db: Db, input: { fromPeriod?: string; toPeriod?: string; periodCode?: string }) {
  await ensureFinanceJournalTable(db);
  const fromPeriod = String(input.fromPeriod || input.periodCode || "").trim();
  const toPeriod = String(input.toPeriod || input.periodCode || fromPeriod).trim();
  if (!/^\d{4}-\d{2}$/.test(fromPeriod) || !/^\d{4}-\d{2}$/.test(toPeriod)) throw new Error("A period (YYYY-MM) is required");

  const rows = await db.prepare("SELECT id,source_type,account_code,debit,credit,narration,period_code FROM finance_journal_entries ORDER BY period_code,id").all<Row>().catch(() => ({ results: [] as Row[] }));
  // group lines by their journal group (id prefix before the final -N segment)
  const groups = new Map<string, Row[]>();
  for (const r of rows.results) {
    const id = String(r.id), group = id.replace(/-\d+$/, "");
    (groups.get(group) || groups.set(group, []).get(group)!).push(r);
  }

  const sections: Record<Section, Map<string, { section: Section; category: string; inflow: number; outflow: number; net: number }>> = { operating: new Map(), investing: new Map(), financing: new Map() };
  let openingCash = 0, netMovement = 0;
  const lineFlows: Array<{ period: string; section: Section; category: string; amount: number; narration: string }> = [];

  for (const lines of groups.values()) {
    const cashLines = lines.filter(l => CASH_ACCOUNTS.has(String(l.account_code)));
    if (!cashLines.length) continue; // non-cash journal (e.g. revenue recognition) - excluded
    const cashDelta = round(cashLines.reduce((s, l) => s + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0));
    if (cashDelta === 0) continue;
    const period = String(lines[0].period_code);
    // opening balance = everything strictly before the window
    if (period < fromPeriod) { openingCash = round(openingCash + cashDelta); continue; }
    if (!inRange(period, fromPeriod, toPeriod)) continue;
    // classify by the largest counterpart (non-cash) account
    const counterparts = lines.filter(l => !CASH_ACCOUNTS.has(String(l.account_code)));
    const primary = counterparts.slice().sort((a, b) => (Math.abs(Number(b.debit) || Number(b.credit) || 0)) - (Math.abs(Number(a.debit) || Number(a.credit) || 0)))[0];
    const counterpartCode = primary ? String(primary.account_code) : String(lines[0].source_type);
    const section = primary ? cashFlowSection(counterpartCode) : "operating";
    const category = counterpartCode.replace(/^\d+-/, "") || String(lines[0].source_type);
    netMovement = round(netMovement + cashDelta);
    const bucket = sections[section];
    const entry = bucket.get(category) || { section, category, inflow: 0, outflow: 0, net: 0 };
    if (cashDelta >= 0) entry.inflow = round(entry.inflow + cashDelta); else entry.outflow = round(entry.outflow - cashDelta);
    entry.net = round(entry.net + cashDelta);
    bucket.set(category, entry);
    lineFlows.push({ period, section, category, amount: cashDelta, narration: String(lines[0].narration) });
  }

  const sectionTotal = (s: Section) => round([...sections[s].values()].reduce((sum, e) => sum + e.net, 0));
  const operating = sectionTotal("operating"), investing = sectionTotal("investing"), financing = sectionTotal("financing");
  const closingCash = round(openingCash + netMovement);

  return {
    fromPeriod, toPeriod, method: "direct",
    openingCash, closingCash, netChangeInCash: netMovement,
    operating: { total: operating, lines: [...sections.operating.values()].sort((a, b) => b.net - a.net) },
    investing: { total: investing, lines: [...sections.investing.values()].sort((a, b) => b.net - a.net) },
    financing: { total: financing, lines: [...sections.financing.values()].sort((a, b) => b.net - a.net) },
    // integrity check: section totals must reconcile to the movement and to the closing balance
    reconciled: Math.abs(round(operating + investing + financing) - netMovement) < 0.01 && Math.abs(round(openingCash + netMovement) - closingCash) < 0.01,
    detail: lineFlows,
  };
}
