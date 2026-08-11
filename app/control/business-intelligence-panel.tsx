"use client";

import { useEffect, useMemo, useState } from "react";
import css from "./business-intelligence.module.css";
import { TrendChart } from "../components/ui";

type View = "Overview" | "Verticals" | "Accounts" | "Customers" | "Subscriptions" | "Reports";
type ReportFormat = "CSV" | "Excel" | "PDF" | "JSON";
type DateBasis = "Customer created date" | "Booking date" | "Service date" | "Payment / collection date" | "Subscription start date" | "Subscription expiry date" | "Subscription renewal date" | "Cancellation / refund date" | "Invoice date" | "Import / record date";
type CustomReport = { name: string; category: string; scope: string; delivery: string; dateBasis: DateBasis; includeCustomerCreatedDate: boolean };
type ReportDefinition = { name: string; category: string; description: string; schedule: string; dateBasis: DateBasis };
type ReportRun = { title: string; format: ReportFormat; dateBasis: DateBasis; from: string; to: string };

const serviceCodeByVertical: Record<string, string> = { Grooming: "grooming", Training: "dog_training", Boarding: "boarding", "Pet Sitting": "pet_sitting" };
type SegmentStats = { count: number; households: number; utilisationPct: number | null };
type SubscriptionBusinessView = { unusedCreditLiability: number | null; liabilityStatus: string; priceCoverage: { known: number; unknown: number }; pauseCancelRate: number | null; segments: { active: SegmentStats; renewalDue7: SegmentStats; expiring30: SegmentStats; expiredWinback: SegmentStats; paused: { count: number; households: number }; cancelled: { count: number; households: number } } };
type CustomerBusinessRow = { customerId: string; name: string; pet: string; createdAt: number | null; segment: string; lastServiceAt: string | null; daysSinceLastService: number | null; orders: number; revenue: number; margin: null; nextAction: string; risk: string };
type LedgerRow = { bookingId: string; vertical: string; invoiceNumber: string | null; gross: number; tax: number; net: number; status: string; method: string | null };
type AccountsBusinessView = { receivable: number; gstPayable: number; refundQueue: { amount: number; count: number; verticalsCovered: string[] }; providerPayable: { amount: number; count: number; verticalsCovered: string[] }; unmatched: number; ledger: LedgerRow[] };
type VerticalRow = { name: string; bookings: number; revenue: number; collected: number; cancelled: number | null; cost: number | null; margin: number | null; repeat: number | null };
const emptyVerticals: VerticalRow[] = Object.keys(serviceCodeByVertical).map(name => ({ name, bookings: 0, revenue: 0, collected: 0, cancelled: null, cost: null, margin: null, repeat: null }));

const reports: ReportDefinition[] = [
  { name:"Founder daily business pulse", category:"Company", description:"Revenue, collections, margin, bookings, cancellations and critical exceptions", schedule:"Daily · 8:30 AM", dateBasis:"Booking date" },
  { name:"Vertical P&L", category:"Finance", description:"Service-wise GST revenue, discounts, direct cost, commission and contribution margin", schedule:"Monthly", dateBasis:"Service date" },
  { name:"Collections & reconciliation", category:"Accounts", description:"Gateway, UPI, cash, refunds, credit notes, failed and unmatched payments", schedule:"Daily", dateBasis:"Payment / collection date" },
  { name:"Customer 360 & LTV", category:"CRM", description:"Customer created date, household, pets, orders, margin, lifecycle, consent and next-best action", schedule:"Weekly", dateBasis:"Customer created date" },
  { name:"Old customer win-back", category:"CRM", description:"Dormancy buckets, last service, value, contact attempts and reactivation conversion", schedule:"Daily", dateBasis:"Service date" },
  { name:"Subscription lifecycle", category:"Subscriptions", description:"Past, active, due, future, utilisation, breakage, renewals and reminders", schedule:"Daily", dateBasis:"Subscription renewal date" },
  { name:"Provider earnings & productivity", category:"Operations", description:"Jobs, utilisation, attendance, ratings, incentives, deductions and payout", schedule:"Weekly", dateBasis:"Service date" },
  { name:"City & zone performance", category:"Expansion", description:"Demand, conversion, revenue, capacity, travel, margin and serviceability", schedule:"Weekly", dateBasis:"Booking date" },
  { name:"Coupons & referrals", category:"Growth", description:"Issue, redemption, discount cost, incremental revenue, abuse and referral settlement", schedule:"Monthly", dateBasis:"Booking date" },
  { name:"GST sales register", category:"Compliance", description:"Invoice-level taxable value, GST, credit notes and payment status", schedule:"Monthly", dateBasis:"Invoice date" },
  { name:"Refunds & cancellations", category:"Quality", description:"Reason, SLA, approval, recovery, provider impact and customer outcome", schedule:"Weekly", dateBasis:"Cancellation / refund date" },
  { name:"Data quality & audit", category:"Governance", description:"Freshness, missing fields, duplicates, imports, changes and export audit", schedule:"Monthly", dateBasis:"Import / record date" },
];

const dateBases: DateBasis[] = ["Customer created date", "Booking date", "Service date", "Payment / collection date", "Subscription start date", "Subscription expiry date", "Subscription renewal date", "Cancellation / refund date", "Invoice date", "Import / record date"];

const money = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value);
const safe = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;

export default function BusinessIntelligencePanel({ notify }: { notify: (message: string) => void }) {
  const [view, setView] = useState<View>("Overview");
  const [city, setCity] = useState("Bengaluru");
  const [service, setService] = useState("All services");
  const [period, setPeriod] = useState("FY 2025–26 through Mar");
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerBusinessRow | null>(null);
  const [query, setQuery] = useState("");
  const [sourceDetails, setSourceDetails] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [reportName, setReportName] = useState("Customer lifecycle report");
  const [reportCategory, setReportCategory] = useState("Customer");
  const [reportScope, setReportScope] = useState("Customer 360 + booking history");
  const [reportDelivery, setReportDelivery] = useState("Excel download");
  const [reportDateBasis, setReportDateBasis] = useState<DateBasis>("Customer created date");
  const [includeCustomerCreatedDate, setIncludeCustomerCreatedDate] = useState(true);
  const [customReports, setCustomReports] = useState<CustomReport[]>([]);
  const [reportRun, setReportRun] = useState<ReportRun | null>(null);
  const [scheduleReport, setScheduleReport] = useState<ReportDefinition | null>(null);
  const [schedulePeriod, setSchedulePeriod] = useState("Previous complete period");

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
      if (!body.error && body.data) setAccountsView(body.data);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/customer-business-view", { cache: "no-store" }).then(r => r.json()).then(body => {
      if (!active) return;
      if (!body.error && Array.isArray(body.data)) setCustomers(body.data);
      setCustomersLoaded(true);
    }).catch(() => { if (active) setCustomersLoaded(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([
      fetch("/api/company-analytics", { cache: "no-store" }).then(r => r.json()),
      fetch("/api/pnl-reporting", { cache: "no-store" }).then(r => r.json()),
      fetch("/api/subscription-business-view", { cache: "no-store" }).then(r => r.json()),
    ]).then(([analyticsBody, pnlBody, subscriptionBody]) => {
      if (!active) return;
      if (analyticsBody.error) throw new Error(analyticsBody.error);
      if (!subscriptionBody.error && subscriptionBody.data) setSubscriptionView(subscriptionBody.data);
      const services = analyticsBody.data?.services || {};
      const rows: VerticalRow[] = Object.entries(serviceCodeByVertical).map(([name, code]) => {
        const s = services[code];
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
      setLiveDataLoaded(true);
    }).catch(e => {
      if (active) { setLiveDataError(e instanceof Error ? e.message : "Unable to load live company data"); setLiveDataLoaded(true); }
    });
    return () => { active = false; };
  }, []);

  const shownVerticals = useMemo(() => service === "All services" ? liveVerticals : liveVerticals.filter(item => item.name === service), [service, liveVerticals]);
  const shownCustomers = useMemo(() => customers.filter(row => !query || `${row.name} ${row.pet} ${row.customerId} ${row.segment}`.toLowerCase().includes(query.toLowerCase())), [query, customers]);
  const revenue = shownVerticals.reduce((sum, item) => sum + item.revenue, 0);
  const collected = shownVerticals.reduce((sum, item) => sum + item.collected, 0);
  const hasCost = shownVerticals.every(item => item.cost != null);
  const cost = hasCost ? shownVerticals.reduce((sum, item) => sum + (item.cost ?? 0), 0) : null;
  const bookings = shownVerticals.reduce((sum, item) => sum + item.bookings, 0);
  function openReportRun(format: ReportFormat, title = "PawSpace business intelligence", dateBasis: DateBasis = "Service date") {
    setReportRun({ title, format, dateBasis, from: "2026-03-01", to: "2026-03-31" });
  }

  function setRunPreset(preset: "Today" | "Yesterday" | "This week" | "This month" | "Last month") {
    if (!reportRun) return;
    const end = new Date();
    const start = new Date(end);
    if (preset === "Yesterday") { start.setDate(end.getDate() - 1); end.setDate(end.getDate() - 1); }
    if (preset === "This week") start.setDate(end.getDate() - ((end.getDay() + 6) % 7));
    if (preset === "This month") start.setDate(1);
    if (preset === "Last month") { start.setMonth(end.getMonth() - 1, 1); end.setDate(0); }
    const iso = (date: Date) => date.toLocaleDateString("en-CA");
    setReportRun({ ...reportRun, from: iso(start), to: iso(end) });
  }

  function exportReport(run: ReportRun) {
    const customerReport = run.title.toLowerCase().includes("customer") || run.dateBasis === "Customer created date";
    const rows: (string | number)[][] = customerReport
      ? [["Customer ID", "Customer", "Pet", "Customer created date", "Segment", "Last service date", "Orders", "Revenue", "Contribution", "Next best action"], ...shownCustomers.map(item => [item.id, item.name, item.pet, item.created, item.segment, item.last, item.orders, item.revenue, item.margin, item.next])]
      : [["Vertical", "Bookings", "Revenue", "Collected", "Direct cost", "Margin %", "Repeat %", "Cancellation %"], ...shownVerticals.map(item => [item.name, item.bookings ?? "Not tracked yet", item.revenue, item.collected ?? "Not tracked yet", item.cost ?? "Not tracked yet", item.margin ?? "Not tracked yet", item.repeat ?? "Not tracked yet", item.cancelled ?? "Not tracked yet"])];
    const { format, title, dateBasis, from, to } = run;
    if (format === "PDF") {
      window.print();
      setReportRun(null);
      notify(`Print view opened for ${from} to ${to} — choose Save as PDF`);
      return;
    }
    let body: string;
    let type: string;
    let extension: string;
    if (format === "JSON") {
      body = JSON.stringify({ title, city, service, dateBasis, from, to, source: "PawSpace protected historical import + platform test records", generatedAt: new Date().toISOString(), rows: customerReport ? shownCustomers : shownVerticals }, null, 2);
      type = "application/json";
      extension = "json";
    } else if (format === "Excel") {
      body = `<html><head><meta charset="utf-8"></head><body><p><strong>Date based on:</strong> ${dateBasis}</p><p><strong>Period:</strong> ${from} to ${to}</p><table>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join("")}</tr>`).join("")}</table></body></html>`;
      type = "application/vnd.ms-excel";
      extension = "xls";
    } else {
      body = [["Date based on", dateBasis], ["From date", from], ["To date", to], [], ...rows].map(row => row.map(safe).join(",")).join("\n");
      type = "text/csv;charset=utf-8";
      extension = "csv";
    }
    const url = URL.createObjectURL(new Blob([body], { type }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `pawspace-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.${extension}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setReportRun(null);
    notify(`${format} report generated for ${from} to ${to} using ${dateBasis.toLowerCase()}`);
  }

  function createCustomReport() {
    const name = reportName.trim();
    if (!name) {
      notify("Enter a report name before saving");
      return;
    }
    setCustomReports(current => [{ name, category: reportCategory, scope: reportScope, delivery: reportDelivery, dateBasis: reportDateBasis, includeCustomerCreatedDate }, ...current]);
    setBuilderOpen(false);
    notify(`${name} saved to the governed report catalogue`);
  }

  function openGoogleDestination(destination: "Google Sheets" | "Google Docs") {
    notify(`${destination} selected — connect Google Drive to create and update files automatically`);
  }

  return <div className={css.stack}>
    <section className={css.hero}>
      <div><span>BUSINESS OPERATIONS & INTELLIGENCE</span><h2>One number, every vertical, down to the customer.</h2><p>Run the company from booking to collection, cost, subscription, reactivation, provider payout and audited management reporting.</p></div>
      <div className={css.heroActions}><button onClick={() => setView("Reports")}>Open report centre</button><button onClick={() => openReportRun("CSV")}>Export current view</button></div>
    </section>

    <section className={css.sourceBanner}>
      <div><i>✓</i><p><strong>Historical import through 31 Mar 2026</strong><span>Protected customer file + PawSpace platform test records · customer contact remains masked</span></p></div>
      <button onClick={() => setSourceDetails(value => !value)}>{sourceDetails ? "Hide lineage" : "View lineage"}</button>
      {sourceDetails && <aside><strong>Metric source order</strong><span>Completed bookings → invoices/credit notes → payment receipts/refunds → provider costs → subscription wallet events → customer master.</span><span>Current figures are a published test snapshot until live operational sources are connected.</span></aside>}
    </section>

    <section className={css.filters} aria-label="Business intelligence filters">
      <label>Period<select value={period} onChange={event => setPeriod(event.target.value)}><option>FY 2025–26 through Mar</option><option>Last 30 days</option><option>Last 90 days</option><option>Custom range</option></select></label>
      <label>City<select value={city} onChange={event => setCity(event.target.value)}><option>Bengaluru</option><option>All cities</option><option>New city pilot</option></select></label>
      <label>Vertical<select value={service} onChange={event => setService(event.target.value)}><option>All services</option>{emptyVerticals.map(item => <option key={item.name}>{item.name}</option>)}</select></label>
      <label>Customer type<select><option>All customers</option><option>New</option><option>Repeat</option><option>Subscriber</option><option>Dormant</option></select></label>
      <button onClick={() => notify("Dashboard refreshed from the protected test snapshot")}>↻ Refresh</button>
    </section>

    <nav className={css.tabs}>{(["Overview", "Verticals", "Accounts", "Customers", "Subscriptions", "Reports"] as View[]).map(item => <button key={item} className={view === item ? css.active : ""} onClick={() => setView(item)}>{item}</button>)}</nav>

    {view === "Overview" && <>
      {!liveDataLoaded && <p style={{ padding: 12, color: "#6c39a8" }}>Loading live company data…</p>}
      {liveDataError && <p style={{ padding: 12, background: "#fff1f1", borderRadius: 10, color: "#9a3d32" }}>Live company data unavailable: {liveDataError}</p>}
      <section className={css.metrics}>
        <article><span>Gross revenue</span><strong>{money(revenue)}</strong><small>Canonical bookings · GST-inclusive</small></article>
        <article><span>Collected</span><strong>{money(collected)}</strong><small>{revenue > 0 ? `${((collected / revenue) * 100).toFixed(1)}% collection rate` : "No bookings in range"}</small></article>
        <article><span>Contribution</span><strong>{cost != null ? money(revenue - cost) : "Not tracked yet"}</strong><small>{cost != null && revenue > 0 ? `${(((revenue - cost) / revenue) * 100).toFixed(1)}% before fixed overhead` : "No real direct-cost source per vertical yet"}</small></article>
        <article><span>Bookings</span><strong>{bookings.toLocaleString("en-IN")}</strong><small>Canonical booking records</small></article>
        <article><span>Customer repeat rate</span><strong>{customerRepeatRate != null ? `${customerRepeatRate}%` : "—"}</strong><small>Real canonical customer repeat rate</small></article>
        {netProfit != null && <article><span>Net profit (P&amp;L, 12 months)</span><strong>{money(netProfit)}</strong><small>From real canonical_bookings + finance_journal_entries</small></article>}
      </section>
      <section className={css.grid}>
        <div className={css.panel}><header><div><span>VERTICAL PERFORMANCE</span><h3>Revenue and contribution</h3><p>Real GST-inclusive booking revenue by vertical.</p></div><button onClick={() => setView("Verticals")}>Drill down →</button></header><TrendChart type="bar" data={shownVerticals} xKey="name" series={[{ key: "revenue", label: "Revenue", color: "#5d22a8" }]} valueFormatter={(value) => money(value)} height={240} /></div>        <aside className={css.panel}><header><div><span>ACTION CENTRE</span><h3>What needs attention</h3></div></header>{[
          ["Renewals", "Open the subscription renewal queue", "Subscriptions"], ["Customers", "Review customer accounts", "Customers"], ["Verticals", "Compare vertical performance", "Verticals"], ["Reports", "Generate a governed report", "Reports"],
        ].map(item => <button className={css.action} key={item[0]} onClick={() => setView(item[2] as View)}><i>{item[0].slice(0, 1)}</i><span><strong>{item[0]}</strong><small>{item[1]}</small></span><b>Open →</b></button>)}</aside>
      </section>
      <section className={css.reconcile}><div><span>CONTROL TOTAL</span><strong>Real booking and collection totals from the canonical company metric layer.</strong></div>{[["Booking value", revenue], ["Collected", collected]].map(item => <article key={item[0] as string}><span>{item[0] as string}</span><strong>{money(item[1] as number)}</strong></article>)}</section>
    </>}

    {view === "Verticals" && <section className={css.panel}><header><div><span>SERVICE P&L</span><h3>Every vertical on the same definition</h3><p>Real bookings/revenue/collected/direct cost/margin/repeat rate for all four verticals, from each vertical&apos;s own real settlement, earnings or incentive data. Grooming&apos;s cost is a real allocation of the incentive engine&apos;s own monthly result, proportional to each booking&apos;s share of that month&apos;s real order value - incentive/bonus cost specifically, not base salary.</p></div><button onClick={() => openReportRun("Excel", "Vertical P&L", "Service date")}>Excel ↓</button></header><div className={css.table}><div className={css.tableHead}><span>Vertical</span><span>Bookings</span><span>Revenue</span><span>Collected</span><span>Direct cost</span><span>Contribution</span><span>Repeat</span><span>Cancel</span></div>{shownVerticals.map(item => <article key={item.name}><strong>{item.name}</strong><span>{item.bookings.toLocaleString("en-IN")}</span><span>{money(item.revenue)}</span><span>{money(item.collected)}</span><span>{item.cost != null ? money(item.cost) : "Not tracked yet"}</span><b>{item.margin != null ? `${item.margin}%` : "Not tracked yet"}</b><span>{item.repeat != null ? `${item.repeat}%` : "Not tracked yet"}</span><span>{item.cancelled != null ? `${item.cancelled}%` : "—"}</span></article>)}</div><footer><strong>Drill-down dimensions:</strong> city, zone, package, subscription, provider model, source, coupon, customer segment, payment mode and booking status.</footer></section>}

    {view === "Accounts" && <>
      {accountsView && <><section className={css.metrics}>{[
        ["Receivable", money(accountsView.receivable), "Booked minus captured, across all bookings"],
        ["Provider payable", money(accountsView.providerPayable.amount), `${accountsView.providerPayable.count} approved payout(s) - ${accountsView.providerPayable.verticalsCovered.join(", ")}`],
        ["Refund queue", money(accountsView.refundQueue.amount), `${accountsView.refundQueue.count} pending - ${accountsView.refundQueue.verticalsCovered.join(", ")}`],
        ["Unmatched", String(accountsView.unmatched), "Booking has an invoice with no captured payment, or the reverse"],
        ["GST payable", money(accountsView.gstPayable), "From issued invoices, all verticals"],
      ].map(item => <article key={item[0]}><span>{item[0]}</span><strong>{item[1]}</strong><small>{item[2]}</small></article>)}</section>
      <section className={css.panel}><header><div><span>ACCOUNTS LEDGER</span><h3>Order to settlement</h3><p>Real invoice + payment records, joined to the booking. Provider payable and refund queue are real for Boarding, Pet Sitting, Pet Taxi and Dog Walking - Training and Grooming use different refund/settlement mechanisms not yet unioned into this view.</p></div><div><button onClick={() => notify("Reconciliation workbench opened")}>Reconcile</button><button onClick={() => openReportRun("CSV", "Accounts ledger", "Payment / collection date")}>CSV ↓</button></div></header><div className={`${css.table} ${css.ledger}`}><div className={css.tableHead}><span>Reference</span><span>Type</span><span>Vertical</span><span>Gross</span><span>GST</span><span>Fee</span><span>Net</span><span>Status</span></div>{accountsView.ledger.length ? accountsView.ledger.map(row => <article key={row.bookingId}><strong>{row.invoiceNumber || row.bookingId}</strong><span>{row.method || "—"}</span><span>{row.vertical}</span><span>{money(row.gross)}</span><span>{money(row.tax)}</span><span>—</span><b>{money(row.net)}</b><em>{row.status}</em></article>) : <p style={{ padding: 12 }}>No invoiced or paid bookings yet.</p>}</div></section></>}
    </>}

    {view === "Customers" && <><div className={css.customerGrid}>      <section className={css.panel}><header><div><span>CUSTOMER-LEVEL BUSINESS INTELLIGENCE</span><h3>Real customer 360 - orders, revenue, subscription-aware segment and risk</h3></div><input aria-label="Search customers" placeholder="Search masked customer, pet or ID" value={query} onChange={event => setQuery(event.target.value)} /></header>{!customersLoaded && <p style={{ padding: 12 }}>Loading real customer data…</p>}{customersLoaded && !shownCustomers.length && <p style={{ padding: 12 }}>No customers found.</p>}{shownCustomers.map(row => <button key={row.customerId} className={`${css.customerRow} ${selectedCustomer?.customerId === row.customerId ? css.selectedCustomer : ""}`} onClick={() => setSelectedCustomer(row)}><i>{row.name.split(" ").map(part => part[0]).join("")}</i><span><strong>{row.name} · {row.pet}</strong><small>{row.customerId} · {row.segment} · {row.createdAt ? `customer since ${new Date(row.createdAt).toLocaleDateString("en-IN")}` : "join date unknown"} · last service {row.lastServiceAt ? new Date(row.lastServiceAt).toLocaleDateString("en-IN") : "never"}</small></span><b>{money(row.revenue)} LTV</b><em>{row.risk}</em></button>)}</section>
      {selectedCustomer && <aside className={css.panel}><span className={css.kicker}>SELECTED CUSTOMER</span><h3>{selectedCustomer.name} · {selectedCustomer.pet}</h3><p className={css.masked}>Primary + secondary numbers protected · purpose-based contact only</p><div className={css.customerMetrics}>{[["Lifetime orders", selectedCustomer.orders], ["Gross revenue", money(selectedCustomer.revenue)], ["Contribution", "Not tracked yet"], ["Days inactive", selectedCustomer.daysSinceLastService ?? "—"]].map(item => <article key={item[0] as string}><span>{item[0] as string}</span><strong>{item[1]}</strong></article>)}</div>{[["Lifecycle", selectedCustomer.segment], ["Risk", selectedCustomer.risk], ["Next best action", selectedCustomer.nextAction], ["Owner", "CRM renewal desk"]].map(item => <p className={css.detail} key={item[0]}><span>{item[0]}</span><strong>{item[1]}</strong></p>)}<div className={css.customerActions}><button onClick={() => notify("Masked call task created and audited")}>Call securely</button><button onClick={() => notify("Personalised offer builder opened")}>Create offer</button></div></aside>}
    </div></>}

    {view === "Subscriptions" && <><section className={css.panel}><header><div><span>SUBSCRIPTION BUSINESS VIEW</span><h3>Past, active, renewal and future value</h3><p>Real segments from customer_grooming_subscriptions - counts, households and utilisation are live. Renewal revenue, cadence adherence, reminder conversion and plan-level contribution have no real aggregate yet.</p></div><button onClick={() => notify("Opening the operational renewal queue")}>Open renewal operations →</button></header>
      {subscriptionView && <>
      <TrendChart type="bar" data={[
        { name: "Active", utilisation: subscriptionView.segments.active.utilisationPct ?? 0 },
        { name: "Renewal due ≤7d", utilisation: subscriptionView.segments.renewalDue7.utilisationPct ?? 0 },
        { name: "Expiring ≤30d", utilisation: subscriptionView.segments.expiring30.utilisationPct ?? 0 },
        { name: "Expired/win-back", utilisation: subscriptionView.segments.expiredWinback.utilisationPct ?? 0 },
      ]} xKey="name" series={[{ key: "utilisation", label: "Utilisation %", color: "#11885b" }]} valueFormatter={(value) => `${value}%`} height={200} />
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
    {view === "Reports" && <>
      <section className={css.reportHeader}><div><span>REPORT CENTRE</span><h3>One governed catalogue—download, attach or schedule.</h3><p>Every report inherits the selected period, city, vertical and customer filters, plus source lineage and export audit. New report definitions can be added whenever the business needs them.</p></div><button onClick={() => setBuilderOpen(value => !value)}>{builderOpen ? "Close builder" : "＋ Create report"}</button></section>
      {builderOpen && <section className={css.reportBuilder} aria-label="Create a new report">
        <header><div><span>FUTURE-READY REPORT BUILDER</span><h3>Create a customer or management report</h3><p>Choose the subject, governed data scope and output. Saved definitions remain reusable, editable and auditable.</p></div></header>
        <div className={css.builderGrid}>
          <label>Report name<input value={reportName} onChange={event => setReportName(event.target.value)} /></label>
          <label>Category<select value={reportCategory} onChange={event => setReportCategory(event.target.value)}><option>Customer</option><option>Business</option><option>Accounts</option><option>Subscriptions</option><option>Operations</option><option>Marketing</option><option>Compliance</option></select></label>
          <label>Data scope<select value={reportScope} onChange={event => setReportScope(event.target.value)}><option>Customer 360 + booking history</option><option>Customer cohort and retention</option><option>Old-customer reactivation</option><option>Revenue, margin and LTV</option><option>Orders, payments and refunds</option><option>Subscription lifecycle</option><option>Custom metrics and dimensions</option></select></label>
          <label>Default output<select value={reportDelivery} onChange={event => setReportDelivery(event.target.value)}><option>Excel download</option><option>CSV download</option><option>PDF / print</option><option>Google Sheets</option><option>Google Docs</option><option>Email attachment</option><option>Secure link</option></select></label>
          <label>Date based on<select value={reportDateBasis} onChange={event => setReportDateBasis(event.target.value as DateBasis)}>{dateBases.map(item => <option key={item}>{item}</option>)}</select></label>
        </div>
        <div className={css.builderChecks}><label><input type="checkbox" defaultChecked /> Mask personal data</label><label><input type="checkbox" checked={includeCustomerCreatedDate} onChange={event => setIncludeCustomerCreatedDate(event.target.checked)} /> Include Customer Created Date column</label><label><input type="checkbox" defaultChecked /> Apply current city and service filters</label><label><input type="checkbox" /> Schedule recurring delivery</label><label><input type="checkbox" defaultChecked /> Require export audit</label></div>
        <footer><span>Advanced controls: metrics · dimensions · filters · date range · grouping · sorting · recipients · approval · expiry.</span><button onClick={createCustomReport}>Save report definition</button></footer>
      </section>}
      <section className={css.reportFormats}><strong>Available outputs</strong>{(["CSV", "Excel", "PDF", "JSON"] as ReportFormat[]).map(format => <button key={format} onClick={() => openReportRun(format)}>{format} ↓</button>)}<button onClick={() => openGoogleDestination("Google Sheets")}>Google Sheets ↗</button><button onClick={() => openGoogleDestination("Google Docs")}>Google Docs ↗</button><button onClick={() => notify("Email attachment schedule opened")}>Email attachment</button><button onClick={() => notify("Secure share-link settings opened")}>Secure link</button></section>
      <section className={css.integrationNote}><i>G</i><div><strong>Google Workspace option retained</strong><span>Sheets is ideal for live tables, analysis and team editing. Docs is ideal for formatted management commentary. Both will use controlled Drive folders, permissions and refresh schedules after Google Drive is connected.</span></div><b>Integration-ready</b></section>
      {customReports.length > 0 && <section className={css.reportList}>{customReports.map(row => <article key={`${row.name}-${row.delivery}`}><i>＋</i><div><strong>{row.name}</strong><span>{row.category} · {row.scope} · Date: {row.dateBasis}</span></div><b>{row.delivery}</b><button onClick={() => notify(`${row.name} editor opened`)}>Edit</button><button onClick={() => openReportRun("Excel", row.name, row.dateBasis)}>Run now</button></article>)}</section>}
      <section className={css.reportList}>{reports.map(row => <article key={row.name}><i>▤</i><div><strong>{row.name}</strong><span>{row.category} · {row.description} · Date: {row.dateBasis}</span></div><b>{row.schedule}</b><button onClick={() => openReportRun("Excel", row.name, row.dateBasis)}>Download</button><button onClick={() => { setScheduleReport(row); setSchedulePeriod("Previous complete period"); }}>Schedule</button></article>)}</section>
      <section className={css.reportSafety}><strong>Export controls</strong><span>Role permission · masking · purpose · row limit · approval · watermark · expiry · download audit · scheduled-recipient review.</span></section>
    </>}

    {reportRun && <div className={css.modalBackdrop} role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setReportRun(null); }}><section className={css.modal} role="dialog" aria-modal="true" aria-labelledby="download-report-title">
      <header><div><span>RUN REPORT</span><h3 id="download-report-title">Select the report date range</h3><p>{reportRun.title}</p></div><button aria-label="Close" onClick={() => setReportRun(null)}>×</button></header>
      <div className={css.quickRanges}>{(["Today", "Yesterday", "This week", "This month", "Last month"] as const).map(item => <button key={item} onClick={() => setRunPreset(item)}>{item}</button>)}</div>
      <div className={css.modalGrid}>
        <label>From date<input type="date" value={reportRun.from} onChange={event => setReportRun({ ...reportRun, from: event.target.value })} /></label>
        <label>To date<input type="date" value={reportRun.to} onChange={event => setReportRun({ ...reportRun, to: event.target.value })} /></label>
        <label>Date based on<select value={reportRun.dateBasis} onChange={event => setReportRun({ ...reportRun, dateBasis: event.target.value as DateBasis })}>{dateBases.map(item => <option key={item}>{item}</option>)}</select></label>
        <label>Export format<select value={reportRun.format} onChange={event => setReportRun({ ...reportRun, format: event.target.value as ReportFormat })}>{(["CSV", "Excel", "PDF", "JSON"] as ReportFormat[]).map(item => <option key={item}>{item}</option>)}</select></label>
      </div>
      {reportRun.dateBasis === "Customer created date" && <div className={css.customerDateNote}><strong>Customer Created Date included</strong><span>The selected range filters customer registration dates, and the exported file includes the Customer Created Date column.</span></div>}
      <footer><span>{city} · {service} · audited export</span><div><button onClick={() => setReportRun(null)}>Cancel</button><button disabled={!reportRun.from || !reportRun.to || reportRun.from > reportRun.to} onClick={() => exportReport(reportRun)}>Generate & download</button></div></footer>
    </section></div>}

    {scheduleReport && <div className={css.modalBackdrop} role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setScheduleReport(null); }}><section className={css.modal} role="dialog" aria-modal="true" aria-labelledby="schedule-report-title">
      <header><div><span>SCHEDULE REPORT</span><h3 id="schedule-report-title">Define the scheduled reporting period</h3><p>{scheduleReport.name} · {scheduleReport.schedule}</p></div><button aria-label="Close" onClick={() => setScheduleReport(null)}>×</button></header>
      <div className={css.modalGrid}>
        <label>Reporting period<select value={schedulePeriod} onChange={event => setSchedulePeriod(event.target.value)}><option>Previous complete period</option><option>Rolling last 7 days</option><option>Rolling last 30 days</option><option>Month to date</option><option>Financial year to date</option><option>Custom relative range</option></select></label>
        <label>Date based on<select value={scheduleReport.dateBasis} onChange={event => setScheduleReport({ ...scheduleReport, dateBasis: event.target.value as DateBasis })}>{dateBases.map(item => <option key={item}>{item}</option>)}</select></label>
        <label>Output format<select defaultValue="Excel"><option>Excel</option><option>CSV</option><option>PDF</option><option>Google Sheets</option><option>Google Docs</option></select></label>
        <label>Delivery cadence<input value={scheduleReport.schedule} readOnly /></label>
      </div>
      <footer><span>Recipients, masking, approval and expiry remain governed.</span><div><button onClick={() => setScheduleReport(null)}>Cancel</button><button onClick={() => { notify(`${scheduleReport.name} scheduled using ${schedulePeriod.toLowerCase()} and ${scheduleReport.dateBasis.toLowerCase()}`); setScheduleReport(null); }}>Save schedule</button></div></footer>
    </section></div>}
  </div>;
}
