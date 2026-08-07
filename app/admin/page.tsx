"use client";
/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { useMemo, useState } from "react";
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

const bookings = [
  { id: "PS-2841", time: "9:00–11:00", customer: "Ananya Rao", pets: "Bruno · Dog", package: "Bath & Basic", groomer: "Arun R.", zone: "Koramangala", amount: 1899, payment: "Paid online", status: "In service" },
  { id: "PS-2842", time: "9:00–11:00", customer: "Rahul Menon", pets: "Coco · Cat", package: "Routine Grooming", groomer: "Deepa K.", zone: "JP Nagar", amount: 1149, payment: "Pay after", status: "In service" },
  { id: "PS-2843", time: "11:00–1:00", customer: "Meera Shah", pets: "Milo, Max · Dogs", package: "Complete Makeover", groomer: "Mohammed K.", zone: "Whitefield", amount: 4298, payment: "Paid online", status: "On the way" },
  { id: "PS-2844", time: "1:00–3:00", customer: "Sanjay Kumar", pets: "Rio · Dog", package: "Essential Bath", groomer: "Priya S.", zone: "Indiranagar", amount: 1349, payment: "Pay after", status: "Confirmed" },
  { id: "PS-2845", time: "3:00–5:00", customer: "Divya Nair", pets: "Luna · Cat", package: "Bath & Basic", groomer: "Naveen J.", zone: "HSR Layout", amount: 1899, payment: "Subscription", status: "Confirmed" },
  { id: "PS-2846", time: "5:00–7:00", customer: "Kiran B.", pets: "Oreo · Cat", package: "Just Trim", groomer: "Deepa K.", zone: "JP Nagar", amount: 1599, payment: "Pay after", status: "Confirmed" },
];

const schedule = [
  { time: "9–11", arun: "PS-2841", priya: "Available", mohammed: "Completed", naveen: "Blocked", deepa: "PS-2842" },
  { time: "11–1", arun: "Travel", priya: "Available", mohammed: "PS-2843", naveen: "Available", deepa: "Travel" },
  { time: "1–3", arun: "PS-2847", priya: "PS-2844", mohammed: "Booked", naveen: "Available", deepa: "PS-2848" },
  { time: "3–5", arun: "Available", priya: "PS-2849", mohammed: "Booked", naveen: "PS-2845", deepa: "Available" },
  { time: "5–7", arun: "Available", priya: "Available", mohammed: "Booked", naveen: "Available", deepa: "PS-2846" },
];

const customers: Customer[] = [
  { id: "CU-10821", name: "Ananya Rao", initials: "AR", primary: "99969 48102", secondary: "98802 22741", pets: "Bruno", petMeta: "Golden Retriever · 4 years", zone: "Koramangala", lastService: "Today · Bath & Basic", lifetime: 18492, subscription: "6-session plan", sessions: 4, stage: "Active customer", owner: "Neha", nextAction: "Renewal call · 18 Aug", source: "Google Ads", opportunity: "Renew subscription" },
  { id: "CU-09642", name: "Rahul Menon", initials: "RM", primary: "98451 33016", secondary: "99860 44912", pets: "Coco", petMeta: "Persian cat · 3 years", zone: "JP Nagar", lastService: "Today · Routine Grooming", lifetime: 12338, subscription: "No active plan", sessions: 0, stage: "Follow-up due", owner: "Rahul", nextAction: "Call today · 4:30 PM", source: "Organic", opportunity: "3-session cat routine" },
  { id: "CU-11208", name: "Meera Shah", initials: "MS", primary: "99008 11876", secondary: "98444 71009", pets: "Milo & Max", petMeta: "2 dogs · family profile", zone: "Whitefield", lastService: "Today · Complete Makeover", lifetime: 29480, subscription: "12-session family wallet", sessions: 7, stage: "VIP", owner: "Neha", nextAction: "No action due", source: "Referral", opportunity: "Boarding cross-sell" },
  { id: "CU-11431", name: "Nisha Patel", initials: "NP", primary: "98861 87001", secondary: "97411 33098", pets: "Milo", petMeta: "Shih Tzu puppy · 8 months", zone: "Indiranagar", lastService: "Booked · Puppy Makeover", lifetime: 1399, subscription: "No active plan", sessions: 0, stage: "New lead", owner: "Unassigned", nextAction: "Training call · today", source: "Website booking", opportunity: "Dog training consultation" },
  { id: "CU-07192", name: "Vikram Reddy", initials: "VR", primary: "98452 66291", secondary: "Not added", pets: "Rocky", petMeta: "Labrador · 6 years", zone: "HSR Layout", lastService: "74 days ago · Essential Bath", lifetime: 9860, subscription: "Expired 3-session plan", sessions: 0, stage: "Dormant", owner: "Sanjay", nextAction: "Win-back WhatsApp · today", source: "Google Ads", opportunity: "Reactivate grooming" },
];

const nav: { id: View; label: string; icon: string; count?: number }[] = [
  { id: "overview", label: "Overview", icon: "⌂" },
  { id: "calendar", label: "Live calendar", icon: "▦" },
  { id: "bookings", label: "Bookings", icon: "▤", count: 18 },
  { id: "crm", label: "Customers & CRM", icon: "◉", count: 418 },
  { id: "training", label: "Training operations", icon: "◆", count: 42 },
  { id: "boarding", label: "Boarding & sitting", icon: "⌂", count: 14 },
  { id: "mobility", label: "Taxi & walking", icon: "↗", count: 11 },
  { id: "food", label: "Fresh food", icon: "●", count: 18 },
  { id: "groomers", label: "Groomers", icon: "♟" },
  { id: "workforce", label: "Workforce & payouts", icon: "₹" },
  { id: "subscriptions", label: "Subscriptions", icon: "◈" },
  { id: "payments", label: "Payments", icon: "₹" },
  { id: "tickets", label: "Support tickets", icon: "◎", count: 3 },
];

const money = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value);

export default function AdminPage() {
  const [view, setView] = useState<View>("overview");
  const [zone, setZone] = useState("All Bangalore zones");
  const [selectedBooking, setSelectedBooking] = useState(bookings[0]);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer>(customers[0]);
  const [crmSearch, setCrmSearch] = useState("");
  const [crmSegment, setCrmSegment] = useState("All customers");
  const [crmTab, setCrmTab] = useState<"profile" | "activity" | "wallet">("profile");
  const [toast, setToast] = useState("");

  const filteredBookings = useMemo(() => zone === "All Bangalore zones" ? bookings : bookings.filter((booking) => booking.zone === zone), [zone]);
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
        <nav>{nav.map((item) => <button key={item.id} className={view === item.id ? styles.activeNav : ""} onClick={() => setView(item.id)}><i>{item.icon}</i><span>{item.label}</span>{item.count && <b>{item.count}</b>}</button>)}</nav>
        <div className={styles.sidebarFooter}><Link href="/team">⌂ Team home</Link><Link href="/team/operations/bookings">▤ Booking Command Center</Link><Link href="/control/integrations">◎ System Integration Control</Link><Link href="/mobile-app">◉ Customer Mobile App</Link><Link href="/regression-lab">✓ Regression Command Centre</Link><Link href="/test-lab">✓ 100-Customer Test Lab</Link><Link href="/platform-api">⬡ Platform API</Link><Link href="/assisted-booking">◎ Assisted Booking</Link><Link href="/partner">◆ Unified Partner App</Link><Link href="/control">◇ Platform Control</Link><Link href="/team/finance">₹ Finance & People OS</Link><Link href="/team/sales">⚡ Advanced CRM</Link><Link href="/">← Customer app</Link><div className={styles.adminUser}><span>KP</span><div><strong>Karthik</strong><small>Super admin</small></div></div></div>
      </aside>

      <section className={styles.workspace}>
        <header className={styles.header}>
          <div><p>Monday · 3 August 2026</p><h1>{title}</h1></div>
          <div className={styles.headerActions}>{view === "crm" ? <><button className={styles.ghostButton} onClick={() => notify("Customer import opened")}>Import customers</button><button className={styles.primaryButton} onClick={() => notify("New lead form opened")}>＋ Add lead</button></> : view === "training" ? <><button className={styles.ghostButton} onClick={() => notify("Assessment queue opened")}>Assessment queue</button><button className={styles.primaryButton} onClick={() => notify("New training plan opened")}>＋ Create plan</button></> : view === "workforce" ? <><button className={styles.ghostButton} onClick={() => notify("Attendance exceptions opened")}>Attendance exceptions</button><button className={styles.primaryButton} onClick={() => notify("Payout approval queue opened")}>Review payouts</button></> : <><select value={zone} onChange={(event) => setZone(event.target.value)}><option>All Bangalore zones</option><option>Koramangala</option><option>Indiranagar</option><option>Whitefield</option><option>HSR Layout</option><option>JP Nagar</option></select><button className={styles.ghostButton} onClick={() => notify("Selected slots blocked for 2 hours")}>Block slot</button><button className={styles.primaryButton} onClick={() => notify("New booking form opened")}>＋ Add booking</button></>}</div>
        </header>
        <TestSyncPanel surface="admin" />

        {(view === "overview" || view === "calendar") && <>
          <section className={styles.metrics}>
            <article><div className={styles.metricIcon}>▤</div><div><span>Today’s bookings</span><strong>18</strong><small>14 confirmed · 4 completed</small></div></article>
            <article><div className={styles.metricIcon}>₹</div><div><span>Expected revenue</span><strong>₹32,482</strong><small className={styles.positive}>↑ 12% vs last Monday</small></div></article>
            <article><div className={styles.metricIcon}>♟</div><div><span>Groomers active</span><strong>8 / 10</strong><small>2 on leave today</small></div></article>
            <article><div className={`${styles.metricIcon} ${styles.alertIcon}`}>!</div><div><span>Open tickets</span><strong>3</strong><small className={styles.warning}>1 needs attention now</small></div></article>
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHead}><div><span className={styles.kicker}>Live capacity</span><h2>Groomer calendar</h2></div><div className={styles.legend}><span><i className={styles.availableDot}></i>Available</span><span><i className={styles.bookedDot}></i>Booked</span><span><i className={styles.travelDot}></i>Travel</span></div></div>
            <div className={styles.scheduleWrap}><table className={styles.schedule}><thead><tr><th>Time</th>{groomers.map((groomer) => <th key={groomer.id}><div className={styles.tableGroomer}><span>{groomer.initials}</span><div><strong>{groomer.name}</strong><small>{groomer.zone}</small></div></div></th>)}</tr></thead><tbody>{schedule.map((row) => <tr key={row.time}><th>{row.time}</th>{groomers.map((groomer) => { const value = row[groomer.id as keyof typeof row]; const booking = typeof value === "string" && value.startsWith("PS-"); const state = booking ? styles.bookedCell : value === "Available" ? styles.availableCell : value === "Travel" ? styles.travelCell : styles.mutedCell; return <td key={groomer.id}><button className={state} onClick={() => booking ? setSelectedBooking(bookings.find((item) => item.id === value) ?? selectedBooking) : notify(`${groomer.name}: ${value}`)}><strong>{value}</strong><small>{booking ? "View booking" : value === "Available" ? "Open for booking" : ""}</small></button></td>; })}</tr>)}</tbody></table></div>
          </section>
        </>}

        {view === "bookings" && <section className={styles.panel}><div className={styles.panelHead}><div><span className={styles.kicker}>Connected operations</span><h2>Modern Booking Command Center</h2></div><Link className={styles.primaryButton} href="/team/operations/bookings">Open command center →</Link></div><p>Control canonical bookings, provider work orders, payments, delay impact, customer communication, tickets, rebooking, refunds and the full audit timeline from one workspace.</p></section>}
        {(view === "overview" || view === "bookings") && <section className={styles.splitGrid}>
          <div className={styles.panel}><div className={styles.panelHead}><div><span className={styles.kicker}>Today</span><h2>Booking activity</h2></div><button className={styles.textButton} onClick={() => setView("bookings")}>View all →</button></div><div className={styles.bookingList}>{filteredBookings.map((booking) => <button key={booking.id} className={selectedBooking.id === booking.id ? styles.selectedBooking : ""} onClick={() => setSelectedBooking(booking)}><span className={styles.timePill}>{booking.time}</span><div><strong>{booking.customer}</strong><small>{booking.pets} · {booking.package}</small></div><div className={styles.bookingMeta}><strong>{money(booking.amount)}</strong><small>{booking.payment}</small></div><span className={`${styles.status} ${styles[booking.status.replaceAll(" ", "").toLowerCase()]}`}>{booking.status}</span></button>)}</div></div>
          <aside className={styles.detailPanel}><div className={styles.panelHead}><div><span className={styles.kicker}>{selectedBooking.id}</span><h2>Booking details</h2></div><button className={styles.moreButton}>•••</button></div><div className={styles.customerCard}><span>{selectedBooking.customer.split(" ").map((part) => part[0]).join("")}</span><div><strong>{selectedBooking.customer}</strong><small>Primary: 99969 99505 · Secondary saved</small></div></div><dl><div><dt>Pet & package</dt><dd>{selectedBooking.pets}<br/><strong>{selectedBooking.package}</strong></dd></div><div><dt>Slot</dt><dd>3 Aug · {selectedBooking.time}<br/><strong>{selectedBooking.zone}</strong></dd></div><div><dt>Assigned groomer</dt><dd>{selectedBooking.groomer}<br/><strong>4.9 ★ verified</strong></dd></div><div><dt>Payment</dt><dd>{selectedBooking.payment}<br/><strong>{money(selectedBooking.amount)}</strong></dd></div></dl><div className={styles.detailActions}><button onClick={() => notify("Reassignment options opened")}>Reassign</button><button onClick={() => notify("Masked chat opened")}>Message</button><button className={styles.dangerButton} onClick={() => notify("Cancellation review opened")}>Cancel</button></div></aside>
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
