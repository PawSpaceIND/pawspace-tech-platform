"use client";
/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import styles from "./admin.module.css";
import TrainingPanel from "./training-panel";
import WorkforcePanel from "./workforce-panel";
import BoardingPanel from "./boarding-panel";
import MobilityPanel from "./mobility-panel";
import FoodPanel from "./food-panel";
import TestSyncPanel from "../components/test-sync-panel";

type View = "overview" | "calendar" | "bookings" | "crm" | "training" | "boarding" | "mobility" | "food" | "groomers" | "workforce" | "subscriptions" | "payments" | "tickets";

type Customer = {
  id: string;
  name: string;
  initials: string;
  primary: string;
  secondary: string;
  pets: string;
  petMeta: string;
  zone: string;
  lastService: string;
  lifetime: number;
  subscription: string;
  sessions: number;
  stage: string;
  owner: string;
  nextAction: string;
  source: string;
  opportunity: string;
};

const groomers = [
  { id: "arun", name: "Arun R.", initials: "AR", zone: "Koramangala", skill: "Dog & Cat", rating: "4.9", jobs: 4, status: "On service" },
  { id: "priya", name: "Priya S.", initials: "PS", zone: "Indiranagar", skill: "Dog & Cat", rating: "4.8", jobs: 3, status: "Available" },
  { id: "mohammed", name: "Mohammed K.", initials: "MK", zone: "Whitefield", skill: "Dog", rating: "4.9", jobs: 5, status: "Travelling" },
  { id: "naveen", name: "Naveen J.", initials: "NJ", zone: "HSR Layout", skill: "Dog & Cat", rating: "4.7", jobs: 2, status: "Available" },
  { id: "deepa", name: "Deepa K.", initials: "DK", zone: "JP Nagar", skill: "Cat", rating: "4.9", jobs: 3, status: "On service" },
];

const customers: Customer[] = [
  { id: "CU-10821", name: "Ananya Rao", initials: "AR", primary: "99969 48102", secondary: "98802 22741", pets: "Bruno", petMeta: "Golden Retriever · 4 years", zone: "Koramangala", lastService: "Today · Bath & Basic", lifetime: 18492, subscription: "6-session plan", sessions: 4, stage: "Active customer", owner: "Neha", nextAction: "Renewal call · 18 Aug", source: "Google Ads", opportunity: "Renew subscription" },
  { id: "CU-09642", name: "Rahul Menon", initials: "RM", primary: "98451 33016", secondary: "99860 44912", pets: "Coco", petMeta: "Persian cat · 3 years", zone: "JP Nagar", lastService: "Today · Routine Grooming", lifetime: 12338, subscription: "No active plan", sessions: 0, stage: "Follow-up due", owner: "Rahul", nextAction: "Call today · 4:30 PM", source: "Organic", opportunity: "3-session cat routine" },
  { id: "CU-11208", name: "Meera Shah", initials: "MS", primary: "99008 11876", secondary: "98444 71009", pets: "Milo & Max", petMeta: "2 dogs · family profile", zone: "Whitefield", lastService: "Today · Complete Makeover", lifetime: 29480, subscription: "12-session family wallet", sessions: 7, stage: "VIP", owner: "Neha", nextAction: "No action due", source: "Referral", opportunity: "Boarding cross-sell" },
  { id: "CU-11431", name: "Nisha Patel", initials: "NP", primary: "98861 87001", secondary: "97411 33098", pets: "Milo", petMeta: "Shih Tzu puppy · 8 months", zone: "Indiranagar", lastService: "Booked · Puppy Makeover", lifetime: 1399, subscription: "No active plan", sessions: 0, stage: "New lead", owner: "Unassigned", nextAction: "Training call · today", source: "Website booking", opportunity: "Dog training consultation" },
  { id: "CU-07192", name: "Vikram Reddy", initials: "VR", primary: "98452 66291", secondary: "Not added", pets: "Rocky", petMeta: "Labrador · 6 years", zone: "HSR Layout", lastService: "74 days ago · Essential Bath", lifetime: 9860, subscription: "Expired 3-session plan", sessions: 0, stage: "Dormant", owner: "Sanjay", nextAction: "Win-back WhatsApp · today", source: "Google Ads", opportunity: "Reactivate grooming" },
];

// Badge counts are only shown where a live count exists. An invented badge is the most quietly
// misleading thing on a nav rail: it looks like a queue length and is checked by nobody.
const nav: { id: View; label: string; icon: string }[] = [
  { id: "overview", label: "Overview", icon: "⌂" },
  { id: "calendar", label: "Live calendar", icon: "▦" },
  { id: "bookings", label: "Bookings", icon: "▤" },
  { id: "crm", label: "Customers & CRM", icon: "◉" },
  { id: "training", label: "Training operations", icon: "◆" },
  { id: "boarding", label: "Boarding & sitting", icon: "⌂" },
  { id: "mobility", label: "Taxi & walking", icon: "↗" },
  { id: "food", label: "Fresh food", icon: "●" },
  { id: "groomers", label: "Groomers", icon: "♟" },
  { id: "workforce", label: "Workforce & payouts", icon: "₹" },
  { id: "subscriptions", label: "Subscriptions", icon: "◈" },
  { id: "payments", label: "Payments", icon: "₹" },
  { id: "tickets", label: "Support tickets", icon: "◎" },
];

const money = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value);


type OverviewMetrics={bookingsToday:number;confirmed:number;completed:number;inProgress:number;cancelled:number;unassigned:number;recognizedRevenue:number;providersActive:number|null;providersTotal:number|null;openTickets:number|null;ticketsNeedingAttention:number|null};
type OverviewCapacity={providerId:string;name:string;zone:string|null;slots:{slot:string;state:"available"|"booked"|"completed";bookingId:string|null;label:string}[]};
type OverviewActivity={bookingId:string;customer:string;service:string;packageName:string;status:string;provider:string|null;scheduledStart:string;scheduledTimeIst:string;slot:string|null;amount:number};
type OverviewData={date:string;dayWindow:{timezone:string;startUtc:string;endUtc:string};zoneId:string|null;zones:string[];metrics:OverviewMetrics;capacity:OverviewCapacity[];capacityShown:number;capacityTotal:number|null;slots:string[];activity:OverviewActivity[];activityShown:number;activityTotal:number;sourceStatus:Record<string,string>};

/** Live operations data. Nothing on this screen is hard-coded: an empty day shows zeros, and a
 *  field with no source shows "Not connected" rather than a plausible-looking number. */
function useOperationsOverview(zoneId:string){
  // The result carries the zone it belongs to, so "loading" is derived rather than flipped with a
  // synchronous setState in the effect body - the zone the user just picked is loading until its own
  // response lands, and a stale zone's numbers are never shown under the new zone's heading.
  const[result,setResult]=useState<{zoneId:string;data:OverviewData|null;error:string}|null>(null);
  useEffect(()=>{let active=true;
    fetch(`/api/operations-overview${zoneId?`?zoneId=${encodeURIComponent(zoneId)}`:""}`,{cache:"no-store"})
      .then(async response=>{const body=await response.json() as {data?:OverviewData;error?:string};
        if(!response.ok)throw new Error(body.error||"Unable to load the operations overview");
        if(active)setResult({zoneId,data:body.data??null,error:""});})
      .catch(problem=>{if(active)setResult({zoneId,data:null,error:problem instanceof Error?problem.message:"Unable to load the operations overview"});});
    return()=>{active=false};},[zoneId]);
  const current=result?.zoneId===zoneId?result:null;
  return{data:current?.data??null,error:current?.error??"",loading:!current};
}
/** The IST day the overview is reporting on, written out for the header. */
const longDay=(day:string)=>{const at=new Date(`${day}T12:00:00+05:30`);return Number.isFinite(at.getTime())?at.toLocaleDateString("en-GB",{timeZone:"Asia/Kolkata",weekday:"long",day:"numeric",month:"long",year:"numeric"}):day;};
const titleCase=(value:string)=>value.replace(/[_-]+/g," ").replace(/\b\w/g,letter=>letter.toUpperCase());
/** Tabs still rendering the built-in sample rows rather than the database. Labelled on screen so a
 *  tester never files a bug against invented data - and so the list shrinks visibly as each is wired. */
const PROTOTYPE_VIEWS=new Set(["groomers","payments","crm","tickets","subscriptions","boarding","mobility","food","workforce"]);
const rupees=(value:number)=>`\u20B9${value.toLocaleString("en-IN")}`;

export default function AdminPage() {
  const [zone, setZone] = useState("");
  const{data:overview,error:overviewError,loading:overviewLoading}=useOperationsOverview(zone);
  const [view, setView] = useState<View>("overview");
  const [selectedBookingId, setSelectedBookingId] = useState("");
  const [selectedCustomer, setSelectedCustomer] = useState<Customer>(customers[0]);
  const [crmSearch, setCrmSearch] = useState("");
  const [crmSegment, setCrmSegment] = useState("All customers");
  const [crmTab, setCrmTab] = useState<"profile" | "activity" | "wallet">("profile");
  const [toast, setToast] = useState("");

  // The zone filter is applied by the API against real zone IDs, so the list here is already scoped.
  const liveActivity = overview?.activity ?? [];
  const selectedActivity = liveActivity.find(row => row.bookingId === selectedBookingId) ?? liveActivity[0] ?? null;
  const filteredCustomers = useMemo(() => customers.filter((customer) => {
    const query = crmSearch.trim().toLowerCase();
    const matchesSearch = !query || `${customer.name} ${customer.primary} ${customer.pets} ${customer.id}`.toLowerCase().includes(query);
    const matchesSegment = crmSegment === "All customers"
      || (crmSegment === "Follow-ups due" && customer.stage === "Follow-up due")
      || (crmSegment === "Training leads" && customer.opportunity.includes("training"))
      || (crmSegment === "Subscriptions" && customer.sessions > 0)
      || (crmSegment === "Dormant 60+ days" && customer.stage === "Dormant");
    return matchesSearch && matchesSegment;
  }), [crmSearch, crmSegment]);
  const title = nav.find((item) => item.id === view)?.label ?? "Overview";

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }

  return (
    <main className={styles.adminShell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}><img src="/assets/pawspace-logo.jpeg" alt="PawSpace" /><span>Operations</span></div>
        <nav>{nav.map((item) => {const count=item.id==="bookings"?overview?.metrics.bookingsToday:item.id==="tickets"?overview?.metrics.openTickets:null;return <button key={item.id} className={view === item.id ? styles.activeNav : ""} onClick={() => setView(item.id)}><i>{item.icon}</i><span>{item.label}</span>{!!count && <b>{count}</b>}</button>;})}</nav>
        <div className={styles.sidebarFooter}><Link href="/team">⌂ Team home</Link><Link href="/team/operations/bookings">▤ Booking Command Center</Link><Link href="/control/integrations">◎ System Integration Control</Link><Link href="/mobile-app">◉ Customer Mobile App</Link><Link href="/regression-lab">✓ Regression Command Centre</Link><Link href="/test-lab">✓ 100-Customer Test Lab</Link><Link href="/platform-api">⬡ Platform API</Link><Link href="/assisted-booking">◎ Assisted Booking</Link><Link href="/partner">◆ Unified Partner App</Link><Link href="/control">◇ Platform Control</Link><Link href="/team/finance">₹ Finance & People OS</Link><Link href="/team/sales">⚡ Advanced CRM</Link><Link href="/">← Customer app</Link><div className={styles.adminUser}><span>KP</span><div><strong>Karthik</strong><small>Super admin</small></div></div></div>
      </aside>

      <section className={styles.workspace}>
        <header className={styles.header}>
          <div><p>{overview?`${longDay(overview.date)} · IST`:"Loading today’s date…"}</p><h1>{title}</h1></div>
          <div className={styles.headerActions}>{view === "crm" ? <><button className={styles.ghostButton} onClick={() => notify("Customer import opened")}>Import customers</button><button className={styles.primaryButton} onClick={() => notify("New lead form opened")}>＋ Add lead</button></> : view === "training" ? <><button className={styles.ghostButton} onClick={() => notify("Assessment queue opened")}>Assessment queue</button><button className={styles.primaryButton} onClick={() => notify("New training plan opened")}>＋ Create plan</button></> : view === "workforce" ? <><button className={styles.ghostButton} onClick={() => notify("Attendance exceptions opened")}>Attendance exceptions</button><button className={styles.primaryButton} onClick={() => notify("Payout approval queue opened")}>Review payouts</button></> : <><select value={zone} onChange={(event) => setZone(event.target.value)} aria-label="Filter by zone"><option value="">All zones</option>{(overview?.zones??[]).map(id=><option key={id} value={id}>{id}</option>)}</select><Link className={styles.ghostButton} href="/team/operations/bookings">Open day board</Link><Link className={styles.primaryButton} href="/assisted-booking">＋ Add booking</Link></>}</div>
        </header>
        <TestSyncPanel surface="admin" />
        {PROTOTYPE_VIEWS.has(view)&&<p className={styles.prototypeNotice}><b>Sample data.</b> This tab still shows built-in example rows, not your database. Overview, Live calendar and Bookings are live.</p>}

        {(view === "overview" || view === "calendar") && <>
          <section className={styles.metrics}>
            <article><div className={styles.metricIcon}>▤</div><div><span>Today’s bookings</span><strong>{overviewLoading?"—":overview?.metrics.bookingsToday ?? 0}</strong><small>{overview?`${overview.metrics.confirmed} confirmed · ${overview.metrics.inProgress} in progress · ${overview.metrics.completed} completed`:"Loading today’s bookings"}</small></div></article>
            <article><div className={styles.metricIcon}>₹</div><div><span>Recognised revenue</span><strong>{overviewLoading?"—":rupees(overview?.metrics.recognizedRevenue ?? 0)}</strong><small>Excludes cancelled &amp; draft · matches the P&amp;L</small></div></article>
            <article><div className={styles.metricIcon}>♟</div><div><span>Providers active</span><strong>{overview?.metrics.providersActive==null?"Not connected":`${overview.metrics.providersActive} / ${overview.metrics.providersTotal}`}</strong><small>Live, active capacity profiles</small></div></article>
            <article><div className={`${styles.metricIcon} ${styles.alertIcon}`}>!</div><div><span>Open tickets</span><strong>{overview?.metrics.openTickets==null?"Not connected":overview.metrics.openTickets}</strong><small className={overview?.metrics.ticketsNeedingAttention?styles.warning:undefined}>{overview?.metrics.ticketsNeedingAttention?`${overview.metrics.ticketsNeedingAttention} past its SLA`:"None past SLA"}</small></div></article>
          </section>
          {overviewError&&<p className={styles.dataError}>{overviewError}</p>}

          <section className={styles.panel}>
            <div className={styles.panelHead}><div><span className={styles.kicker}>Live capacity · {overview?.dayWindow.timezone??"IST"}</span><h2>Provider day board</h2></div><div className={styles.legend}><span><i className={styles.availableDot}></i>Available</span><span><i className={styles.bookedDot}></i>Booked</span><span><i className={styles.travelDot}></i>Completed</span></div></div>
            {!!overview&&overview.capacityTotal!=null&&overview.capacityShown<overview.capacityTotal&&<p className={styles.dataNote}>Showing {overview.capacityShown} of {overview.capacityTotal} active providers. Filter by zone to see the rest.</p>}
            <div className={styles.scheduleWrap}>
              {overviewLoading&&<p className={styles.dataNote}>Loading today’s capacity…</p>}
              {!overviewLoading&&!overview?.capacity.length&&<p className={styles.dataNote}>No active provider has capacity configured for today. Add a provider capacity profile to see the live board.</p>}
              {!!overview?.capacity.length&&<table className={styles.schedule}>
                <thead><tr><th>Time</th>{overview.capacity.map(provider=><th key={provider.providerId}><div className={styles.tableGroomer}><span>{provider.name.split(" ").map(part=>part[0]).slice(0,2).join("").toUpperCase()}</span><div><b>{provider.name}</b>{provider.zone&&<small>{provider.zone}</small>}</div></div></th>)}</tr></thead>
                <tbody>{overview.slots.map((slot,index)=><tr key={slot}><th>{slot}</th>{overview.capacity.map(provider=>{const cell=provider.slots[index];return <td key={provider.providerId+slot}><div className={cell.state==="available"?styles.slotAvailable:cell.state==="completed"?styles.slotCompleted:styles.slotBooked}><b>{cell.bookingId??"Available"}</b><small>{cell.label}</small></div></td>;})}</tr>)}</tbody>
              </table>}
            </div>
          </section>
        </>}

        {view === "bookings" && <section className={styles.panel}><div className={styles.panelHead}><div><span className={styles.kicker}>Connected operations</span><h2>Modern Booking Command Center</h2></div><Link className={styles.primaryButton} href="/team/operations/bookings">Open command center →</Link></div><p>Control canonical bookings, provider work orders, payments, delay impact, customer communication, tickets, rebooking, refunds and the full audit timeline from one workspace.</p></section>}
        {(view === "overview" || view === "bookings") && <section className={styles.splitGrid}>
          <div className={styles.panel}><div className={styles.panelHead}><div><span className={styles.kicker}>Today</span><h2>Booking activity</h2></div><Link className={styles.textButton} href="/team/operations/bookings">View all →</Link></div>
            {overviewLoading&&<p className={styles.dataNote}>Loading today’s bookings…</p>}
            {!overviewLoading&&!liveActivity.length&&<p className={styles.dataNote}>No bookings are scheduled for this day{zone?` in ${zone}`:""}. This is a live read of canonical_bookings, not an empty template.</p>}
            {!!overview&&overview.activityShown<overview.activityTotal&&<p className={styles.dataNote}>Showing the first {overview.activityShown} of {overview.activityTotal} bookings today.</p>}
            {!!liveActivity.length&&<div className={styles.bookingList}>{liveActivity.map(row => <button key={row.bookingId} className={selectedActivity?.bookingId === row.bookingId ? styles.selectedBooking : ""} onClick={() => setSelectedBookingId(row.bookingId)}><span className={styles.timePill}>{row.scheduledTimeIst||"—"}</span><div><strong>{row.customer}</strong><small>{titleCase(row.service)} · {row.packageName}</small></div><div className={styles.bookingMeta}><strong>{money(row.amount)}</strong><small>{row.provider??"Unassigned"}</small></div><span className={styles.status}>{titleCase(row.status)}</span></button>)}</div>}
          </div>
          <aside className={styles.detailPanel}><div className={styles.panelHead}><div><span className={styles.kicker}>{selectedActivity?.bookingId??"No booking selected"}</span><h2>Booking details</h2></div></div>
            {!selectedActivity&&<p className={styles.dataNote}>Select a booking from today’s list to see its details.</p>}
            {!!selectedActivity&&<>
              <div className={styles.customerCard}><span>{selectedActivity.customer.split(" ").map(part => part[0]).join("").slice(0,2).toUpperCase()}</span><div><strong>{selectedActivity.customer}</strong><small>{titleCase(selectedActivity.service)}</small></div></div>
              <dl>
                <div><dt>Package</dt><dd><strong>{selectedActivity.packageName||"—"}</strong></dd></div>
                <div><dt>Slot ({overview?.dayWindow.timezone??"IST"})</dt><dd>{overview?longDay(overview.date):""}<br/><strong>{selectedActivity.scheduledTimeIst||"—"}{selectedActivity.slot?` · ${selectedActivity.slot}`:""}</strong></dd></div>
                <div><dt>Assigned provider</dt><dd><strong>{selectedActivity.provider??"Not assigned yet"}</strong></dd></div>
                <div><dt>Status &amp; value</dt><dd>{titleCase(selectedActivity.status)}<br/><strong>{money(selectedActivity.amount)}</strong></dd></div>
              </dl>
              <div className={styles.detailActions}><Link href={`/team/operations/bookings?bookingId=${encodeURIComponent(selectedActivity.bookingId)}`}>Open in Command Center</Link></div>
            </>}
          </aside>
        </section>}

        {view === "crm" && <>
          <section className={styles.crmMetrics}>
            <article><span>Customer database</span><strong>50,000+</strong><small>One profile across web, app & CRM</small></article>
            <article><span>Follow-ups due</span><strong>418</strong><small className={styles.warning}>96 overdue today</small></article>
            <article><span>Active subscribers</span><strong>6,482</strong><small>386 plans expire in 30 days</small></article>
            <article><span>Open sales value</span><strong>₹4.2L</strong><small className={styles.positive}>Grooming, training & boarding</small></article>
          </section>

          <section className={styles.crmToolbar}>
            <label><span>⌕</span><input value={crmSearch} onChange={(event) => setCrmSearch(event.target.value)} placeholder="Search name, phone, pet or customer ID" /></label>
            <select value={crmSegment} onChange={(event) => setCrmSegment(event.target.value)}><option>All customers</option><option>Follow-ups due</option><option>Training leads</option><option>Subscriptions</option><option>Dormant 60+ days</option></select>
            <button onClick={() => notify("Smart campaign builder opened")}>Create campaign</button>
          </section>

          <section className={styles.crmLayout}>
            <div className={styles.customerListPanel}>
              <div className={styles.crmListHead}><div><span className={styles.kicker}>Unified contacts</span><h2>{filteredCustomers.length} customers shown</h2></div><button onClick={() => notify("List sorted by next action")}>Next action ↓</button></div>
              <div className={styles.crmTableHead}><span>Customer</span><span>Relationship</span><span>Next action</span><span>Owner</span></div>
              <div className={styles.crmRows}>{filteredCustomers.map((customer) => <button key={customer.id} className={selectedCustomer.id === customer.id ? styles.selectedCustomer : ""} onClick={() => setSelectedCustomer(customer)}>
                <div className={styles.crmIdentity}><i>{customer.initials}</i><div><strong>{customer.name}</strong><small>{customer.primary} · {customer.zone}</small></div></div>
                <div><span className={`${styles.crmStage} ${styles[customer.stage.replaceAll(" ", "").toLowerCase()]}`}>{customer.stage}</span><small>{customer.pets} · {customer.lastService}</small></div>
                <div><strong>{customer.nextAction}</strong><small>{customer.opportunity}</small></div>
                <span className={styles.owner}>{customer.owner}</span>
              </button>)}</div>
              {filteredCustomers.length === 0 && <div className={styles.emptyState}>No customers match this search or segment.</div>}
            </div>

            <aside className={styles.customer360}>
              <div className={styles.customer360Head}><span>{selectedCustomer.initials}</span><div><small>{selectedCustomer.id}</small><h2>{selectedCustomer.name}</h2><p>{selectedCustomer.primary} · {selectedCustomer.zone}</p></div><button>•••</button></div>
              <div className={styles.quickActions}><button onClick={() => notify(`Calling ${selectedCustomer.name}`)}>☎ Call</button><button onClick={() => notify("WhatsApp conversation opened")}>◉ WhatsApp</button><button onClick={() => notify("Booking form prefilled")}>＋ Book</button></div>
              <div className={styles.crmTabs}><button className={crmTab === "profile" ? styles.activeCrmTab : ""} onClick={() => setCrmTab("profile")}>Profile</button><button className={crmTab === "activity" ? styles.activeCrmTab : ""} onClick={() => setCrmTab("activity")}>Activity</button><button className={crmTab === "wallet" ? styles.activeCrmTab : ""} onClick={() => setCrmTab("wallet")}>Wallet</button></div>

              {crmTab === "profile" && <div className={styles.crmProfile}>
                <div className={styles.petProfile}><span>🐾</span><div><small>Registered pets</small><strong>{selectedCustomer.pets}</strong><p>{selectedCustomer.petMeta}</p></div><button onClick={() => notify("Pet profile opened")}>View</button></div>
                <dl><div><dt>Primary number</dt><dd>{selectedCustomer.primary}</dd></div><div><dt>Secondary number</dt><dd>{selectedCustomer.secondary}</dd></div><div><dt>Lead source</dt><dd>{selectedCustomer.source}</dd></div><div><dt>Lifetime value</dt><dd>{money(selectedCustomer.lifetime)}</dd></div></dl>
                <div className={styles.opportunity}><span>Best next opportunity</span><strong>{selectedCustomer.opportunity}</strong><p>Suggested using pet age, booking history and subscription status.</p><button onClick={() => notify("Follow-up assigned and reminder scheduled")}>Assign follow-up</button></div>
              </div>}

              {crmTab === "activity" && <div className={styles.timeline}>
                <article><i></i><div><strong>{selectedCustomer.lastService}</strong><p>Booking synced from customer app</p><small>Today</small></div></article>
                <article><i></i><div><strong>WhatsApp confirmation delivered</strong><p>Primary and secondary contact updated</p><small>Today · 9:02 AM</small></div></article>
                <article><i></i><div><strong>Sales note added by {selectedCustomer.owner}</strong><p>{selectedCustomer.opportunity} discussed</p><small>Last interaction</small></div></article>
                <button onClick={() => notify("Note editor opened")}>＋ Add note or call outcome</button>
              </div>}

              {crmTab === "wallet" && <div className={styles.walletCard}>
                <span>Subscription wallet</span><h3>{selectedCustomer.subscription}</h3><strong>{selectedCustomer.sessions} sessions remaining</strong><div><span>Valid for all registered family pets</span><b>{selectedCustomer.sessions > 0 ? "Active" : "No balance"}</b></div><button onClick={() => notify("Subscription options opened")}>{selectedCustomer.sessions > 0 ? "Manage wallet" : "Sell subscription"}</button>
              </div>}

              <div className={styles.followUpBar}><div><span>Next action</span><strong>{selectedCustomer.nextAction}</strong></div><button onClick={() => notify("Follow-up marked complete")}>✓ Complete</button></div>
            </aside>
          </section>

          <section className={styles.automationStrip}><div><span>⚡</span><p><strong>CRM automation ready</strong><br/>Website and app activity can automatically create leads, update customer profiles and schedule follow-ups.</p></div><button onClick={() => notify("Automation rules opened")}>View rules</button></section>
        </>}

        {view === "groomers" && <section className={styles.groomerGrid}>{groomers.map((groomer) => <article className={styles.groomerCard} key={groomer.id}><div className={styles.groomerTop}><span>{groomer.initials}</span><i className={groomer.status === "Available" ? styles.online : styles.busy}></i></div><h3>{groomer.name}</h3><p>{groomer.skill} grooming</p><dl><div><dt>Zone</dt><dd>{groomer.zone}</dd></div><div><dt>Rating</dt><dd>{groomer.rating} ★</dd></div><div><dt>Jobs today</dt><dd>{groomer.jobs}</dd></div></dl><button onClick={() => notify(`${groomer.name}'s calendar opened`)}>Open calendar</button></article>)}</section>}

        {view === "training" && <TrainingPanel notify={notify} />}

        {view === "boarding" && <BoardingPanel notify={notify} />}

        {view === "mobility" && <MobilityPanel notify={notify} />}

        {view === "food" && <FoodPanel notify={notify} />}

        {view === "workforce" && <WorkforcePanel notify={notify} />}

        {view === "subscriptions" && <section className={styles.panel}><div className={styles.panelHead}><div><span className={styles.kicker}>Customer wallets</span><h2>Active subscriptions</h2></div><button className={styles.primaryButton}>＋ Add subscription</button></div><div className={styles.subscriptionStats}><article><span>Active plans</span><strong>6,482</strong><small>4,930 customers</small></article><article><span>Sessions remaining</span><strong>28,614</strong><small>Across all wallets</small></article><article><span>Expiring in 30 days</span><strong>386</strong><small>Reminder queue ready</small></article></div><div className={styles.notice}><strong>Family wallet rules active</strong><p>6- and 12-session plans can be shared across registered dogs and cats. Sessions are deducted only after service completion.</p></div></section>}

        {view === "payments" && <section className={styles.splitGrid}><div className={styles.panel}><div className={styles.panelHead}><div><span className={styles.kicker}>3 August</span><h2>Payment reconciliation</h2></div><button className={styles.ghostButton}>Export</button></div><div className={styles.paymentRows}><div><span>Online · Razorpay</span><strong>₹18,994</strong><small>11 transactions · matched</small></div><div><span>Pay-after-service · UPI</span><strong>₹8,390</strong><small>5 dynamic QR payments</small></div><div><span>Cash collected</span><strong>₹5,098</strong><small>3 groomers · reconciliation pending</small></div><div className={styles.totalRow}><span>Total expected</span><strong>₹32,482</strong></div></div></div><aside className={styles.detailPanel}><span className={styles.kicker}>Attention</span><h2>Cash to collect</h2><div className={styles.cashItem}><span>AR</span><div><strong>Arun R.</strong><small>2 bookings</small></div><b>₹2,698</b></div><div className={styles.cashItem}><span>DK</span><div><strong>Deepa K.</strong><small>1 booking</small></div><b>₹1,599</b></div><button className={styles.primaryButton} onClick={() => notify("Cash reconciliation started")}>Start reconciliation</button></aside></section>}

        {view === "tickets" && <section className={styles.panel}><div className={styles.panelHead}><div><span className={styles.kicker}>Operations queue</span><h2>Support tickets</h2></div><select><option>All priorities</option><option>Urgent</option><option>Normal</option></select></div><div className={styles.ticketList}><article><span className={styles.urgentTag}>Urgent</span><div><strong>Groomer waiting · Customer unreachable</strong><p>PS-2838 · 15-minute reminder sent · HSR Layout</p></div><button onClick={() => notify("Ticket assigned to you")}>Resolve</button></article><article><span className={styles.normalTag}>Payment</span><div><strong>Dynamic QR payment not matched</strong><p>PS-2829 · ₹1,899 received · Whitefield</p></div><button onClick={() => notify("Payment matching opened")}>Review</button></article><article><span className={styles.normalTag}>Reschedule</span><div><strong>Preferred groomer unavailable</strong><p>PS-2851 · Customer wants Arun R. · Koramangala</p></div><button onClick={() => notify("Alternative slots displayed")}>Review</button></article></div></section>}
      </section>
      {toast && <div className={styles.toast}>✓ {toast}</div>}
    </main>
  );
}
