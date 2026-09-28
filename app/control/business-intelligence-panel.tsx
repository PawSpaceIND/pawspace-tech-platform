"use client";
import VisualAnalytics from "../components/ui/VisualAnalytics";

import { useEffect, useMemo, useState } from "react";
import css from "./business-intelligence.module.css";
import { TrendChart } from "../components/ui";
import Link from "next/link";
import { MetricBars, VisualGrid, statusCounts } from "../components/ui/ReportVisuals";
import { downloadSnapshot } from "../../lib/report-snapshot-export";

type View = "Overview" | "Verticals" | "Accounts" | "Customers" | "Subscriptions" | "Reports";
const serviceCodeByVertical: Record<string, string> = { Grooming: "grooming", Training: "dog_training", Boarding: "boarding", "Pet Sitting": "pet_sitting", "Dog Walking": "dog_walking", "Pet Taxi": "pet_taxi", "Pet Food": "pet_food", Daycare:"daycare", "Vet Consultation":"vet_consult" };
type SegmentStats = { count: number; households: number; utilisationPct: number | null };
type SubscriptionBusinessView = { unusedCreditLiability: number | null; liabilityStatus: string; priceCoverage: { known: number; unknown: number }; pauseCancelRate: number | null; segments: { active: SegmentStats; renewalDue7: SegmentStats; expiring30: SegmentStats; expiredWinback: SegmentStats; paused: { count: number; households: number }; cancelled: { count: number; households: number } } };
type CustomerBusinessRow = { customerId: string; name: string; pet: string; createdAt: number | null; segment: string; lastServiceAt: string | null; daysSinceLastService: number | null; orders: number; revenue: number; margin: null; nextAction: string; risk: string };
type LedgerRow = { bookingId: string; vertical: string; invoiceNumber: string | null; gross: number; tax: number; net: number; status: string; method: string | null };
type AccountsBusinessView = { receivable: number; gstPayable: number; refundQueue: { amount: number; count: number; verticalsCovered: string[] }; providerPayable: { amount: number; count: number; verticalsCovered: string[] }; unmatched: number; ledger: LedgerRow[] };
type VerticalRow = { name: string; bookings: number; revenue: number; collected: number; cancelled: number | null; cost: number | null; margin: number | null; repeat: number | null };
const emptyVerticals: VerticalRow[] = [];

const money = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value);


export default function BusinessIntelligencePanel({ notify }: { notify: (message: string) => void }) {
  const [view, setView] = useState<View>("Overview");
  const [refresh, setRefresh] = useState(0);
  const [snapshotAt, setSnapshotAt] = useState("");
  const [sourceErrors, setSourceErrors] = useState<Record<string,string>>({});
  const [service, setService] = useState("All services");

  const [selectedCustomer, setSelectedCustomer] = useState<CustomerBusinessRow | null>(null);
  const [query, setQuery] = useState("");
  const [sourceDetails, setSourceDetails] = useState(false);
  const [liveVerticals, setLiveVerticals] = useState<VerticalRow[]>(emptyVerticals);
  const [liveDataLoaded, setLiveDataLoaded] = useState(false);
  const [liveDataError, setLiveDataError] = useState("");
  const [netProfit, setNetProfit] = useState<number | null>(null);
  const [customerRepeatRate, setCustomerRepeatRate] = useState<number | null>(null);
  const [subscriptionView, setSubscriptionView] = useState<SubscriptionBusinessView | null>(null);
  const [customers, setCustomers] = useState<CustomerBusinessRow[]>([]);
  const [customersLoaded, setCustomersLoaded] = useState(false);
  const [accountsView, setAccountsView] = useState<AccountsBusinessView | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/accounts-business-view", { cache: "no-store" }).then(r => r.json()).then(body => {
      if (!active) return;
      if (body.error || !body.data) throw new Error(body.error || "Accounts unavailable");
      setAccountsView(body.data);
    }).catch(error => { if(active) setSourceErrors(current => ({...current, Accounts: String(error.message)})); });
    return () => { active = false; };
  }, [refresh]);

  useEffect(() => {
    let active = true;
    fetch("/api/customer-business-view", { cache: "no-store" }).then(r => r.json()).then(body => {
      if (!active) return;
      if (body.error || !Array.isArray(body.data)) throw new Error(body.error || "Customers unavailable");
      setCustomers(body.data);
      setCustomersLoaded(true);
    }).catch(error => { if (active) { setSourceErrors(current => ({...current, Customers: String(error.message)})); setCustomersLoaded(true); } });
    return () => { active = false; };
  }, [refresh]);

  useEffect(() => {
    let active = true;
    Promise.all([
      fetch("/api/company-analytics", { cache: "no-store" }).then(r => r.json()),
      fetch("/api/pnl-reporting", { cache: "no-store" }).then(r => r.json()),
      fetch("/api/subscription-business-view", { cache: "no-store" }).then(r => r.json()),
    ]).then(([analyticsBody, pnlBody, subscriptionBody]) => {
      if (!active) return;
      if (analyticsBody.error || !analyticsBody.data?.services) throw new Error(analyticsBody.error || "Company source unavailable");
      if (analyticsBody.data.degraded) throw new Error(analyticsBody.data.degraded.headline || "Company source incomplete");
      if (!subscriptionBody.error && subscriptionBody.data) setSubscriptionView(subscriptionBody.data);
      else setSourceErrors(current => ({...current, Subscriptions: subscriptionBody.error || "Subscriptions unavailable"}));
      const services = analyticsBody.data?.services || {};
      const rows: VerticalRow[] = Object.entries(services).map(([code, raw]) => {
        const name = Object.entries(serviceCodeByVertical).find(([, value]) => value === code)?.[0] || code.replaceAll("_", " ");
        const s = raw as {bookings:number;gmv:number;collected:number;cancelled:number;costAmount:number|null;marginPct:number|null;repeatRate:number|null};
        return {
          name, bookings: s?.bookings ?? 0, revenue: s?.gmv ?? 0, collected: s?.collected ?? 0,
          cancelled: s && s.bookings > 0 ? Math.round((s.cancelled / s.bookings) * 1000) / 10 : null,
          cost: s?.costAmount ?? null, margin: s?.marginPct ?? null,
          repeat: s?.repeatRate != null ? Math.round(s.repeatRate * 1000) / 10 : null,
        };
      });
      setLiveVerticals(rows);
      setCustomerRepeatRate(analyticsBody.data?.customers?.repeatRate != null ? Math.round(analyticsBody.data.customers.repeatRate * 1000) / 10 : null);
      if (!pnlBody.error && pnlBody.data) setNetProfit(pnlBody.data.nettProfitAmount ?? null);
      setSnapshotAt(new Date().toLocaleString("en-IN", {timeZone:"Asia/Kolkata"}));
      setLiveDataLoaded(true);
    }).catch(e => {
      if (active) { setLiveDataError(e instanceof Error ? e.message : "Unable to load live company data"); setLiveDataLoaded(true); }
    });
    return () => { active = false; };
  }, [refresh]);

  const shownVerticals = useMemo(() => service === "All services" ? liveVerticals : liveVerticals.filter(item => item.name === service), [service, liveVerticals]);
  const shownCustomers = useMemo(() => customers.filter(row => !query || `${row.name} ${row.pet} ${row.customerId} ${row.segment}`.toLowerCase().includes(query.toLowerCase())), [query, customers]);
  const revenue = shownVerticals.reduce((sum, item) => sum + item.revenue, 0);
  const collected = shownVerticals.reduce((sum, item) => sum + item.collected, 0);
  const hasCost = shownVerticals.every(item => item.cost != null);
  const cost = hasCost ? shownVerticals.reduce((sum, item) => sum + (item.cost ?? 0), 0) : null;
  const bookings = shownVerticals.reduce((sum, item) => sum + item.bookings, 0);
  function exportSnapshot(format: "CSV" | "JSON", scope: View = view) {
    const records = scope === "Customers" ? shownCustomers : scope === "Accounts" ? accountsView?.ledger : scope === "Subscriptions" ? (subscriptionView ? Object.entries(subscriptionView.segments).map(([segment, values]) => ({segment, ...values})) : undefined) : shownVerticals;
    if (!records || (scope === "Customers" && !customersLoaded) || sourceErrors[scope] || ((scope === "Overview" || scope === "Verticals" || scope === "Reports") && (!liveDataLoaded || liveDataError))) { notify("This source is unavailable. Refresh before exporting."); return; }
    downloadSnapshot(`pawspace-${scope.toLowerCase()}-snapshot`, records, {scope, period:"All records returned by source; no date filter", service: scope === "Overview" || scope === "Verticals" || scope === "Reports" ? service : "All services", customerSearch:scope === "Customers" ? query : "", loadedAt:snapshotAt, generatedAt:new Date().toISOString()}, format);
    notify(`${scope} ${format} snapshot downloaded`);
  }
  function reloadSources() {
    setLiveDataLoaded(false); setLiveDataError(""); setSourceErrors({}); setAccountsView(null); setCustomersLoaded(false); setCustomers([]); setSubscriptionView(null); setRefresh(value => value + 1);
  }

  return <div className={css.stack}>
    <section className={css.hero}>
      <div><span>BUSINESS OPERATIONS & INTELLIGENCE</span><h2>One number, every vertical, down to the customer.</h2><p>Run the company from booking to collection, cost, subscription, reactivation, provider payout and audited management reporting.</p></div>
      <div className={css.heroActions}><button onClick={() => setView("Reports")}>Open report centre</button><button onClick={() => exportSnapshot("CSV")}>Export current view</button></div>
    </section>

    <section className={css.sourceBanner}>
      <div><i>✓</i><p><strong>Connected business snapshot</strong><span>All accessible records · refreshed {snapshotAt || "on load"} IST</span></p></div>
      <button onClick={() => setSourceDetails(value => !value)}>{sourceDetails ? "Hide lineage" : "View lineage"}</button>
      {sourceDetails && <aside><strong>Metric source order</strong><span>Completed bookings → invoices/credit notes → payment receipts/refunds → provider costs → subscription wallet events → customer master.</span><span>Snapshot totals below cover all records returned by each source. The trend explorer has its own date filters and CSV export. P&amp;L covers 12 months. Service filters apply to the trend explorer and vertical totals only.</span></aside>}
    </section>

    <section className={css.filters} aria-label="Business intelligence filters">
      <label>Vertical totals<select value={service} onChange={event => setService(event.target.value)}><option>All services</option>{Object.keys(serviceCodeByVertical).map(name => <option key={name}>{name}</option>)}</select></label>
      <button onClick={reloadSources}>↻ Refresh snapshots</button>
    </section>

    <nav className={css.tabs} aria-label="Company report sections">{(["Overview", "Verticals", "Accounts", "Customers", "Subscriptions", "Reports"] as View[]).map(item => <button key={item} aria-pressed={view === item} className={view === item ? css.active : ""} onClick={() => setView(item)}>{item}</button>)}</nav>
    {(view === "Overview" || view === "Reports") && <VisualAnalytics key={refresh} serviceCode={serviceCodeByVertical[service]} title="Revenue, trends & comparisons" />}

    {view === "Overview" && liveDataLoaded && !liveDataError && <>
      {!liveDataLoaded && <p style={{ padding: 12, color: "var(--paw-link)" }}>Loading live company data…</p>}
      {liveDataError && <p style={{ padding: 12, background: "var(--staff-danger-bg, #fff1f1)", borderRadius: "calc(10px * var(--paw-radius-scale))", color: "var(--staff-muted, #9a3d32)" }}>Live company data unavailable: {liveDataError}</p>}
      <section className={css.metrics}>
        <article><span>Gross revenue</span><strong>{money(revenue)}</strong><small>Canonical bookings · GST-inclusive</small></article>
        <article><span>Collected</span><strong>{money(collected)}</strong><small>{revenue > 0 ? `${((collected / revenue) * 100).toFixed(1)}% collection rate` : "No bookings in range"}</small></article>
        <article><span>Contribution</span><strong>{cost != null ? money(revenue - cost) : "Not tracked yet"}</strong><small>{cost != null && revenue > 0 ? `${(((revenue - cost) / revenue) * 100).toFixed(1)}% before fixed overhead` : "No real direct-cost source per vertical yet"}</small></article>
        <article><span>Bookings</span><strong>{bookings.toLocaleString("en-IN")}</strong><small>Canonical booking records</small></article>
        <article><span>Customer repeat rate (all services)</span><strong>{customerRepeatRate != null ? `${customerRepeatRate}%` : "—"}</strong><small>Real canonical customer repeat rate</small></article>
        {netProfit != null && <article><span>Net profit (P&amp;L, 12 months)</span><strong>{money(netProfit)}</strong><small>From real canonical_bookings + finance_journal_entries</small></article>}
      </section>
      <section className={css.grid}>
        <div className={css.panel}><header><div><span>VERTICAL PERFORMANCE</span><h3>Revenue and contribution</h3><p>Real GST-inclusive booking revenue by vertical.</p></div><button onClick={() => setView("Verticals")}>Drill down →</button></header><TrendChart type="bar" data={shownVerticals} xKey="name" series={[{ key: "revenue", label: "Revenue", color: "#5d22a8" }]} valueFormatter={(value) => money(value)} height={240} /></div>        <aside className={css.panel}><header><div><span>ACTION CENTRE</span><h3>What needs attention</h3></div></header>{[
          ["Renewals", "Open the subscription renewal queue", "Subscriptions"], ["Customers", "Review customer accounts", "Customers"], ["Verticals", "Compare vertical performance", "Verticals"], ["Reports", "Export source records", "Reports"],
        ].map(item => <button className={css.action} key={item[0]} onClick={() => setView(item[2] as View)}><i>{item[0].slice(0, 1)}</i><span><strong>{item[0]}</strong><small>{item[1]}</small></span><b>Open →</b></button>)}</aside>
      </section>
      <section className={css.reconcile}><div><span>CONTROL TOTAL</span><strong>Real booking and collection totals from the canonical company metric layer.</strong></div>{[["Booking value", revenue], ["Collected", collected]].map(item => <article key={item[0] as string}><span>{item[0] as string}</span><strong>{money(item[1] as number)}</strong></article>)}</section>
    </>}

    {view === "Verticals" && liveDataLoaded && !liveDataError && <section className={css.panel}><header><div><span>SERVICE P&L</span><h3>Every vertical on the same definition</h3><p>Real bookings/revenue/collected/direct cost/margin/repeat rate for the available verticals, from each vertical&apos;s own real settlement, earnings or incentive data. Grooming&apos;s cost is a real allocation of the incentive engine&apos;s own monthly result, proportional to each booking&apos;s share of that month&apos;s real order value - incentive/bonus cost specifically, not base salary.</p></div><button onClick={() => exportSnapshot("CSV", "Verticals")}>CSV ↓</button></header><div className={css.table}><div className={css.tableHead}><span>Vertical</span><span>Bookings</span><span>Revenue</span><span>Collected</span><span>Direct cost</span><span>Contribution</span><span>Repeat</span><span>Cancel</span></div>{shownVerticals.map(item => <article key={item.name}><strong>{item.name}</strong><span>{item.bookings.toLocaleString("en-IN")}</span><span>{money(item.revenue)}</span><span>{money(item.collected)}</span><span>{item.cost != null ? money(item.cost) : "Not tracked yet"}</span><b>{item.margin != null ? `${item.margin}%` : "Not tracked yet"}</b><span>{item.repeat != null ? `${item.repeat}%` : "Not tracked yet"}</span><span>{item.cancelled != null ? `${item.cancelled}%` : "—"}</span></article>)}</div><footer>All-records snapshot. Use the trend explorer above for dated comparisons and booking drill-down.</footer></section>}

    {view === "Accounts" && <>
      {accountsView && <><VisualGrid><MetricBars title="Money awaiting action" note="Independent balances; these categories can overlap. All-records snapshot." format={money} items={[{label:"Receivable",value:accountsView.receivable},{label:"Provider payable",value:accountsView.providerPayable.amount},{label:"Refund queue",value:accountsView.refundQueue.amount,tone:"warning"},{label:"GST payable",value:accountsView.gstPayable}]} /><MetricBars title="Invoice and payment status" note="Counts from the ledger displayed below." items={statusCounts(accountsView.ledger)} /></VisualGrid><section className={css.metrics}>{[
        ["Receivable", money(accountsView.receivable), "Booked minus captured, across all bookings"],
        ["Provider payable", money(accountsView.providerPayable.amount), `${accountsView.providerPayable.count} approved payout(s) - ${accountsView.providerPayable.verticalsCovered.join(", ")}`],
        ["Refund queue", money(accountsView.refundQueue.amount), `${accountsView.refundQueue.count} pending - ${accountsView.refundQueue.verticalsCovered.join(", ")}`],
        ["Unmatched", String(accountsView.unmatched), "Booking has an invoice with no captured payment, or the reverse"],
        ["GST payable", money(accountsView.gstPayable), "From issued invoices, all verticals"],
      ].map(item => <article key={item[0]}><span>{item[0]}</span><strong>{item[1]}</strong><small>{item[2]}</small></article>)}</section>
      <section className={css.panel}><header><div><span>ACCOUNTS LEDGER</span><h3>Order to settlement</h3><p>Real invoice + payment records, joined to the booking. Provider payable and refund queue are real for Boarding, Pet Sitting, Pet Taxi and Dog Walking - Training and Grooming use different refund/settlement mechanisms not yet unioned into this view.</p></div><div><Link href="/team/finance">Reconciliation workspace →</Link><button onClick={() => exportSnapshot("CSV", "Accounts")}>CSV ↓</button></div></header><div className={`${css.table} ${css.ledger}`}><div className={css.tableHead}><span>Reference</span><span>Type</span><span>Vertical</span><span>Gross</span><span>GST</span><span>Fee</span><span>Net</span><span>Status</span></div>{accountsView.ledger.length ? accountsView.ledger.map(row => <article key={row.bookingId}><strong>{row.invoiceNumber || row.bookingId}</strong><span>{row.method || "—"}</span><span>{row.vertical}</span><span>{money(row.gross)}</span><span>{money(row.tax)}</span><span>—</span><b>{money(row.net)}</b><em>{row.status}</em></article>) : <p style={{ padding: 12 }}>No invoiced or paid bookings yet.</p>}</div></section></>}
    </>}

    {view === "Customers" && <><VisualGrid><MetricBars title="Customer lifecycle" note="Matches the customer search below · all records." items={statusCounts(shownCustomers.map(row => ({status:row.segment})))} /><MetricBars title="Customer attention" note="Risk labels recorded by the customer source." items={statusCounts(shownCustomers.map(row => ({status:row.risk})))} /></VisualGrid><div className={css.customerGrid}>      <section className={css.panel}><header><div><span>CUSTOMER-LEVEL BUSINESS INTELLIGENCE</span><h3>Real customer 360 - orders, revenue, subscription-aware segment and risk</h3></div><input aria-label="Search customers" placeholder="Search masked customer, pet or ID" value={query} onChange={event => setQuery(event.target.value)} /></header>{!customersLoaded && <p style={{ padding: 12 }}>Loading real customer data…</p>}{customersLoaded && !shownCustomers.length && <p style={{ padding: 12 }}>No customers found.</p>}{shownCustomers.map(row => <button key={row.customerId} className={`${css.customerRow} ${selectedCustomer?.customerId === row.customerId ? css.selectedCustomer : ""}`} onClick={() => setSelectedCustomer(row)}><i>{row.name.split(" ").map(part => part[0]).join("")}</i><span><strong>{row.name} · {row.pet}</strong><small>{row.customerId} · {row.segment} · {row.createdAt ? `customer since ${new Date(row.createdAt).toLocaleDateString("en-IN")}` : "join date unknown"} · last service {row.lastServiceAt ? new Date(row.lastServiceAt).toLocaleDateString("en-IN") : "never"}</small></span><b>{money(row.revenue)} LTV</b><em>{row.risk}</em></button>)}</section>
      {selectedCustomer && <aside className={css.panel}><span className={css.kicker}>SELECTED CUSTOMER</span><h3>{selectedCustomer.name} · {selectedCustomer.pet}</h3><p className={css.masked}>Primary + secondary numbers protected · purpose-based contact only</p><div className={css.customerMetrics}>{[["Lifetime orders", selectedCustomer.orders], ["Gross revenue", money(selectedCustomer.revenue)], ["Contribution", "Not tracked yet"], ["Days inactive", selectedCustomer.daysSinceLastService ?? "—"]].map(item => <article key={item[0] as string}><span>{item[0] as string}</span><strong>{item[1]}</strong></article>)}</div>{[["Lifecycle", selectedCustomer.segment], ["Risk", selectedCustomer.risk], ["Next best action", selectedCustomer.nextAction], ["Owner", "CRM renewal desk"]].map(item => <p className={css.detail} key={item[0]}><span>{item[0]}</span><strong>{item[1]}</strong></p>)}<div className={css.customerActions}><Link href="/team/sales">Open governed sales workspace →</Link></div></aside>}
    </div></>}

    {view === "Subscriptions" && <><section className={css.panel}><header><div><span>SUBSCRIPTION BUSINESS VIEW</span><h3>Past, active, renewal and future value</h3><p>Real segments from customer_grooming_subscriptions - counts, households and utilisation are live. Renewal revenue, cadence adherence, reminder conversion and plan-level contribution have no real aggregate yet.</p></div><Link href="/team/sales">Review customer actions →</Link></header>
      {subscriptionView && <>
      <VisualGrid><MetricBars title="Subscription utilisation" note="Recorded session utilisation; unavailable values are not zero. Segments may overlap." format={value => `${value}%`} items={[
        {label:"Active",value:subscriptionView.segments.active.utilisationPct},
        {label:"Renewal due ≤7 days",value:subscriptionView.segments.renewalDue7.utilisationPct},
        {label:"Expiring ≤30 days",value:subscriptionView.segments.expiring30.utilisationPct},
        {label:"Expired / win-back",value:subscriptionView.segments.expiredWinback.utilisationPct},
      ]}/></VisualGrid>
      <div className={css.subscriptionGrid}>
        <article><div><strong>Active</strong><span>{subscriptionView.segments.active.households.toLocaleString("en-IN")} households</span></div><b>{subscriptionView.segments.active.count.toLocaleString("en-IN")}</b><small>{subscriptionView.segments.active.utilisationPct != null ? `${subscriptionView.segments.active.utilisationPct}% utilised` : "No utilisation data"}</small></article>
        <article><div><strong>Renewal due ≤7 days</strong><span>{subscriptionView.segments.renewalDue7.households.toLocaleString("en-IN")} households</span></div><b>{subscriptionView.segments.renewalDue7.count.toLocaleString("en-IN")}</b><small>{subscriptionView.segments.renewalDue7.utilisationPct != null ? `${subscriptionView.segments.renewalDue7.utilisationPct}% utilised` : "No utilisation data"}</small></article>
        <article><div><strong>Expiring ≤30 days</strong><span>{subscriptionView.segments.expiring30.households.toLocaleString("en-IN")} households</span></div><b>{subscriptionView.segments.expiring30.count.toLocaleString("en-IN")}</b><small>{subscriptionView.segments.expiring30.utilisationPct != null ? `${subscriptionView.segments.expiring30.utilisationPct}% utilised` : "No utilisation data"}</small></article>
        <article><div><strong>Expired / win-back</strong><span>{subscriptionView.segments.expiredWinback.households.toLocaleString("en-IN")} households</span></div><b>{subscriptionView.segments.expiredWinback.count.toLocaleString("en-IN")}</b><small>{subscriptionView.segments.expiredWinback.utilisationPct != null ? `${subscriptionView.segments.expiredWinback.utilisationPct}% utilised` : "No utilisation data"}</small></article>
        <article><div><strong>Paused</strong><span>{subscriptionView.segments.paused.households.toLocaleString("en-IN")} households</span></div><b>{subscriptionView.segments.paused.count.toLocaleString("en-IN")}</b><small>Pause/cancel rate {subscriptionView.pauseCancelRate != null ? `${subscriptionView.pauseCancelRate}%` : "—"}</small></article>
        <article><div><strong>Unused-credit liability</strong><span>{subscriptionView.liabilityStatus === "partial_price_coverage" ? `Partial - ${subscriptionView.priceCoverage.unknown} plan(s) unpriced` : "All active plans priced"}</span></div><b>{subscriptionView.unusedCreditLiability != null ? money(subscriptionView.unusedCreditLiability) : "Not tracked yet"}</b><small>From real remaining sessions × real per-session plan price</small></article>
      </div>
      </>}
      <footer><strong>Real today:</strong> segment counts, households, session utilisation, unused-credit liability, pause/cancel rate. <strong>Not yet real:</strong> renewal rate, renewal revenue, cadence adherence, reminder conversion, bot/human conversion, plan-level contribution.</footer></section></>}
    {view === "Reports" && <section className={css.panel}><header><div><span>REPORT CENTRE</span><h3>Export the records you can inspect</h3><p>Use the trend explorer above for date-filtered CSV reports. Snapshot exports below contain all records returned by their source, with scope and generation time. Scheduled delivery and custom report definitions are not connected.</p></div></header>
      <div className={css.reportList}>{(["Verticals", "Accounts", "Customers", "Subscriptions"] as View[]).map(scope => <article key={scope}><div><strong>{scope} snapshot</strong><span>{scope === "Accounts" ? "Actual invoice and payment ledger rows" : scope === "Customers" ? "Customer records matching the search" : scope === "Subscriptions" ? "Recorded lifecycle segments" : "Service totals matching the vertical selector"}</span></div><button onClick={() => setView(scope)}>Inspect records</button><button onClick={() => exportSnapshot("CSV", scope)}>CSV ↓</button><button onClick={() => exportSnapshot("JSON", scope)}>JSON ↓</button></article>)}</div>
    </section>}
    {(view === "Overview" || view === "Verticals") && !liveDataLoaded && <p role="status">Loading company snapshot…</p>}
    {(view === "Overview" || view === "Verticals") && liveDataError && <p role="alert">Company snapshot unavailable: {liveDataError}</p>}
    {view === "Accounts" && !accountsView && !sourceErrors.Accounts && <p role="status">Loading accounts…</p>}
    {view === "Subscriptions" && !subscriptionView && !sourceErrors.Subscriptions && <p role="status">Loading subscriptions…</p>}
    {sourceErrors[view] && <p role="alert">{view} unavailable: {sourceErrors[view]} <button onClick={reloadSources}>Retry</button></p>}
  </div>;
}
