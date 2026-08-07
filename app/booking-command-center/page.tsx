"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import styles from "./page.module.css";

type Row = Record<string, unknown>;
type Booking = Row & { pets: Row[]; lifecycle: Row[]; operations: Row[]; notifications: Row[]; rebooking: Row[]; refunds: Row[]; tickets: Row[]; adminActions: Row[] };
type Tab = "Overview" | "Journey" | "Payments" | "Communication" | "Tickets & refunds";

const money = (value: unknown) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(Number(value || 0));
const pretty = (value: unknown) => String(value || "Not recorded").replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase());
const when = (value: unknown) => { const date = new Date(typeof value === "number" ? value : String(value)); return Number.isNaN(date.valueOf()) ? "Not scheduled" : date.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "numeric", minute: "2-digit" }); };
const initials = (name: unknown) => String(name || "PS").split(" ").map(part => part[0]).join("").slice(0, 2).toUpperCase();

export default function BookingCommandCenter() {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("All bookings");
  const [tab, setTab] = useState<Tab>("Overview");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [actionReason, setActionReason] = useState("Customer service and booking follow-up");

  async function load() {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/booking-command-center", { cache: "no-store" });
      const payload = await response.json() as { bookings?: Booking[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "Unable to load bookings");
      setBookings(payload.bookings || []);
      setSelectedId(current => current || payload.bookings?.[0]?.id as string || "");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load bookings"); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    let active = true;
    fetch("/api/booking-command-center", { cache: "no-store" })
      .then(async response => {
        const payload = await response.json() as { bookings?: Booking[]; error?: string };
        if (!response.ok) throw new Error(payload.error || "Unable to load bookings");
        if (!active) return;
        setBookings(payload.bookings || []);
        setSelectedId(payload.bookings?.[0]?.id as string || "");
      })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "Unable to load bookings"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const visible = useMemo(() => bookings.filter(booking => {
    const haystack = `${booking.id} ${booking.customer_name} ${booking.primary_phone} ${booking.package_name} ${booking.provider_name} ${booking.zone_id} ${booking.service_code}`.toLowerCase();
    const matchesQuery = !query.trim() || haystack.includes(query.trim().toLowerCase());
    const risky = booking.operations.length > 0 || booking.tickets.some(ticket => ticket.status !== "resolved") || booking.rebooking.length > 0;
    const matchesFilter = filter === "All bookings" || (filter === "Needs attention" && risky) || (filter === "Unassigned" && !booking.provider_id) || (filter === "Payment pending" && !["paid", "captured", "completed"].includes(String(booking.payment_status))) || pretty(booking.status) === filter;
    return matchesQuery && matchesFilter;
  }), [bookings, filter, query]);
  const selected = bookings.find(booking => booking.id === selectedId) || visible[0];
  const risks = bookings.filter(booking => booking.operations.length || booking.tickets.some(ticket => ticket.status !== "resolved") || booking.rebooking.length).length;
  const paymentPending = bookings.filter(booking => !["paid", "captured", "completed"].includes(String(booking.payment_status))).length;

  async function adminAction(action: string) {
    if (!selected) return;
    const response = await fetch("/api/booking-command-center", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bookingId: selected.id, action, reason: actionReason }) });
    const payload = await response.json() as { error?: string; deliveryStatus?: string };
    setToast(response.ok ? `${pretty(action)} recorded · ${payload.deliveryStatus || "saved"}` : payload.error || "Action failed");
    if (response.ok) await load();
    window.setTimeout(() => setToast(""), 3200);
  }

  const mergedTimeline = selected ? [
    ...selected.lifecycle.map(item => ({ ...item, event: item.event_type, at: item.occurred_at, source: "Lifecycle" })),
    ...selected.operations.map(item => ({ ...item, event: item.event_type, at: item.created_at, source: "Operations" })),
    ...selected.adminActions.map(item => ({ ...item, event: item.action, at: item.created_at, source: "Admin" })),
  ].sort((a, b) => Number(b.at) - Number(a.at)) : [];

  return <main className={styles.shell}>
    <aside className={styles.side}>
      <Link href="/team" className={styles.logo}><b>paw</b>space <span>TEAM · OPS</span></Link>
      <nav><strong>OPERATIONS</strong><Link href="/team">⌂ Team home</Link><Link className={styles.active} href="/team/operations/bookings">▤ Booking Command Center</Link><Link href="/team/operations">▦ Live calendar</Link><Link href="/team/sales">⚡ Revenue & CX</Link><Link href="/control">◇ Launch essentials</Link><Link href="/control/integrations">◎ System integration</Link></nav>
      <div className={styles.uatrecord}><b>UAT CONTROLLED</b><span>Canonical booking records</span><span>Sandbox payments</span><span>Queued communications</span></div>
      <Link href="/team" className={styles.back}>← Back to Team</Link>
    </aside>

    <section className={styles.workspace}>
      <header className={styles.top}><div><span>PAWSPACE OPERATIONS</span><h1>Booking Command Center</h1><p>One place to control every booking, provider, payment and exception.</p></div><div><button onClick={() => void load()}>↻ Refresh</button><Link href="/assisted-booking">＋ Add booking</Link></div></header>
      <section className={styles.metrics}>
        <article><span>Total bookings</span><b>{bookings.length}</b><small>Canonical UAT records</small></article>
        <article><span>Needs attention</span><b className={risks ? styles.red : ""}>{risks}</b><small>Delay, ticket or rebooking</small></article>
        <article><span>Payment pending</span><b>{paymentPending}</b><small>Includes pay-after service</small></article>
        <article><span>Open revenue</span><b>{money(bookings.reduce((sum, booking) => sum + Number(booking.amount_due_now || 0), 0))}</b><small>Due now across records</small></article>
      </section>

      <section className={styles.controls}><label>⌕<input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search booking, customer, pet, phone or provider" /></label><div>{["All bookings", "Needs attention", "Payment pending", "Confirmed", "Completed"].map(item => <button key={item} className={filter === item ? styles.filterActive : ""} onClick={() => setFilter(item)}>{item}</button>)}</div></section>

      {loading && <div className={styles.state}>Loading connected booking records…</div>}
      {error && <div className={`${styles.state} ${styles.error}`}>{error}<button onClick={() => void load()}>Try again</button></div>}
      {!loading && !error && !bookings.length && <div className={styles.state}><b>No canonical bookings yet</b><span>Create a UAT booking from the customer app and it will appear here with the same linked IDs.</span><Link href="/mobile-app">Open customer test app</Link></div>}

      {!loading && !error && bookings.length > 0 && <section className={styles.commandGrid}>
        <div className={styles.listPanel}>
          <header><div><span>COMMAND LIST</span><h2>{visible.length} booking{visible.length === 1 ? "" : "s"}</h2></div><small>Live from shared UAT database</small></header>
          <div className={styles.listHead}><span>Booking</span><span>Customer & service</span><span>Provider</span><span>Payment</span><span>Risk</span></div>
          <div className={styles.rows}>{visible.map(booking => {
            const petNames = booking.pets.map(pet => pet.name).join(", ") || "Pet not recorded";
            const openTicket = booking.tickets.find(ticket => ticket.status !== "resolved");
            const latestOperation = booking.operations[0];
            const risk = openTicket ? `${pretty(openTicket.priority)} ticket` : latestOperation ? pretty(latestOperation.event_type) : booking.rebooking.length ? "Rebooking open" : "On track";
            return <button key={String(booking.id)} className={selected?.id === booking.id ? styles.selected : ""} onClick={() => { setSelectedId(String(booking.id)); setTab("Overview"); }}>
              <span><b>{String(booking.id)}</b><small>{when(booking.scheduled_start)}</small></span>
              <span><b>{String(booking.customer_name)}</b><small>{petNames} · {pretty(booking.service_code)} · {String(booking.package_name)}</small></span>
              <span><b>{String(booking.provider_name || "Unassigned")}</b><small>{pretty(booking.work_order_status)}</small></span>
              <span><b>{money(booking.payment_amount)}</b><small>{pretty(booking.payment_status)} · {pretty(booking.payment_mode)}</small></span>
              <em className={risk === "On track" ? styles.safe : styles.risk}>{risk}</em>
            </button>;
          })}</div>
          {!visible.length && <div className={styles.noMatch}>No bookings match this view.</div>}
        </div>

        {selected && <aside className={styles.detail}>
          <header className={styles.detailHead}><div><span>{String(selected.id)} · {pretty(selected.service_code)}</span><h2>{pretty(selected.status)}</h2><p>{when(selected.scheduled_start)} · {pretty(selected.zone_id)}</p></div><em>{selected.tickets.some(ticket => ticket.status !== "resolved") ? "ACTION NEEDED" : "ON TRACK"}</em></header>
          <div className={styles.actionBar}><button onClick={() => void adminAction("call_customer")}>☎ Call</button><button onClick={() => void adminAction("whatsapp_customer")}>◉ WhatsApp</button><button onClick={() => void adminAction("open_tracking")}>⌖ Tracking</button><button onClick={() => void adminAction("review_reassignment")}>↻ Reassign</button></div>
          <label className={styles.reason}>Action reason<input value={actionReason} onChange={event => setActionReason(event.target.value)} /></label>
          <div className={styles.tabs}>{(["Overview", "Journey", "Payments", "Communication", "Tickets & refunds"] as Tab[]).map(item => <button key={item} className={tab === item ? styles.tabActive : ""} onClick={() => setTab(item)}>{item}</button>)}</div>

          {tab === "Overview" && <div className={styles.tabBody}>
            <section className={styles.identity}><span>{initials(selected.customer_name)}</span><div><small>CUSTOMER</small><b>{String(selected.customer_name)}</b><p>{String(selected.primary_phone || "Phone unavailable")} · {String(selected.customer_email || "Email not added")}</p></div><Link href="/crm">Customer 360 →</Link></section>
            <div className={styles.cards}>
              <article><span>PET & CARE</span><b>{selected.pets.map(pet => pet.name).join(", ")}</b>{selected.pets.map(pet => <p key={String(pet.id)}>{pretty(pet.species)} · {String(pet.breed || "Breed not recorded")} · Vaccine {pretty(pet.vaccination_status)}</p>)}</article>
              <article><span>SERVICE & PACKAGE</span><b>{String(selected.package_name)}</b><p>{pretty(selected.service_code)} · {Number(selected.occurrence_count || 1)} occurrence(s)</p><p>Booking source: {pretty(selected.channel)}</p></article>
              <article><span>PROVIDER WORK ORDER</span><b>{String(selected.provider_name || "Unassigned")}</b><p>{String(selected.work_order_id)} · {pretty(selected.work_order_status)}</p><p>{pretty(selected.provider_model)}</p></article>
              <article><span>PAYMENT</span><b>{money(selected.payment_amount)}</b><p>{pretty(selected.payment_mode)} · {pretty(selected.payment_status)}</p><p>{String(selected.payment_id)} · {pretty(selected.gateway)}</p></article>
            </div>
            <section className={styles.alerts}><header><div><span>OPERATIONAL WATCH</span><h3>Exceptions affecting this order</h3></div></header>{!selected.operations.length && !selected.tickets.length && !selected.rebooking.length ? <p className={styles.clear}>✓ No active delay, ticket or rebooking exception.</p> : <>{selected.operations.slice(0, 3).map(item => <article key={String(item.id)}><b>{pretty(item.event_type)}</b><span>{String(item.reason)} · {Number(item.impact_minutes || 0)} minute impact</span></article>)}{selected.tickets.filter(ticket => ticket.status !== "resolved").map(ticket => <article key={String(ticket.id)}><b>{pretty(ticket.priority)} · {String(ticket.subject)}</b><span>{pretty(ticket.status)} · SLA {when(ticket.sla_due_at)}</span></article>)}</>}</section>
          </div>}

          {tab === "Journey" && <div className={styles.tabBody}><section className={styles.timeline}><header><span>UNIFIED ORDER TIMELINE</span><h3>{mergedTimeline.length} recorded events</h3></header>{mergedTimeline.map((item, index) => <article key={`${String(item.id)}-${index}`}><i></i><div><b>{pretty(item.event)}</b><p>{String(item.reason || item.source)}</p><small>{when(item.at)} · {String(item.source)}</small></div></article>)}</section></div>}
          {tab === "Payments" && <div className={styles.tabBody}><div className={styles.financeHero}><div><span>PAYMENT STATUS</span><h3>{pretty(selected.payment_status)}</h3><p>{pretty(selected.payment_mode)} · {pretty(selected.payment_method)}</p></div><b>{money(selected.payment_amount)}</b></div><div className={styles.cards}><article><span>Due now</span><b>{money(selected.amount_due_now)}</b><p>Gateway: {pretty(selected.gateway)}</p></article><article><span>Refund cases</span><b>{selected.refunds.length}</b><p>{selected.refunds[0] ? `${pretty(selected.refunds[0].status)} · ${money(selected.refunds[0].amount)}` : "No refund requested"}</p></article></div></div>}
          {tab === "Communication" && <div className={styles.tabBody}><section className={styles.feed}><header><span>CUSTOMER COMMUNICATION LOG</span><h3>{selected.notifications.length + selected.adminActions.length} actions</h3></header>{selected.notifications.map(item => <article key={String(item.id)}><b>{pretty(item.channel)} · {pretty(item.status)}</b><p>{String(item.message)}</p><small>{when(item.created_at)}</small></article>)}{!selected.notifications.length && <p className={styles.clear}>No queued or delivered messages on this booking.</p>}</section></div>}
          {tab === "Tickets & refunds" && <div className={styles.tabBody}><div className={styles.dual}><section className={styles.feed}><header><span>LINKED TICKETS</span><h3>{selected.tickets.length}</h3></header>{selected.tickets.map(item => <article key={String(item.id)}><b>{String(item.subject)}</b><p>{pretty(item.priority)} · {pretty(item.status)} · Level {Number(item.escalation_level || 0)}</p><small>Customer sees: {String(item.customer_status)}</small></article>)}{!selected.tickets.length && <p className={styles.clear}>No customer-experience ticket linked.</p>}<Link href="/crm">Open CX ticket desk →</Link></section><section className={styles.feed}><header><span>REFUND & REBOOKING</span><h3>{selected.refunds.length + selected.rebooking.length}</h3></header>{selected.refunds.map(item => <article key={String(item.id)}><b>Refund · {pretty(item.status)}</b><p>{money(item.amount)} · {String(item.reason)}</p><small>{String(item.gateway_reference || "Gateway reference pending")}</small></article>)}{selected.rebooking.map(item => <article key={String(item.id)}><b>Rebooking · {pretty(item.status)}</b><p>{String(item.reason)}</p><small>Eligible {when(item.eligible_at)}</small></article>)}{!selected.refunds.length && !selected.rebooking.length && <p className={styles.clear}>No refund or rebooking case linked.</p>}</section></div></div>}
        </aside>}
      </section>}
      {toast && <div className={styles.toast}>{toast}</div>}
    </section>
  </main>;
}
