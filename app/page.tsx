"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import TestSyncPanel from "./components/test-sync-panel";
import GroomingFlow, { GROOMING_SLOTS, resolveGroomingPackId } from "./mobile-app/grooming-flow";
import CustomerLogin, { type LoggedInCustomer } from "./mobile-app/customer-login";
import { loadCustomerAccount } from "../lib/customer-account-client";
import { groomingBookingDates, groomingSlotFitsRoster } from "../lib/grooming-booking-calendar";

type PetType = "dog" | "cat";
type OfferType = "regular" | "young" | "subscription";
type Package = {
  id: string;
  name: string;
  detail: string;
  price: number;
  multiPrice?: number;
  badge?: string;
};


/*
 * The booking on this page is the GOVERNED grooming flow, not a second implementation of one.
 *
 * MEASURED before this change: app/page.tsx read no customer session at all, its OTP step issued zero
 * network requests and said so on screen ("Prototype note: OTP verification is simulated for review"),
 * its "registered pet" list was a hardcoded fixture, and it synthesised identity as `WEB-<phone>` from
 * an unverified number. Because it held no session, on any non-preview host its FIRST API call returned
 * 401 - after the customer had entered name, phone, address, pet, safety notes and payment preference.
 *
 * app/mobile-app/grooming-flow.tsx already books grooming correctly: the customer's own pets, a
 * resolved service location and one canonical lifecycle call. The marketing page keeps its job;
 * pressing the booking control hands over to that flow, and signing in uses the existing CustomerLogin
 * rather than a second identity model. [PTJA-P1-F38]
 */

const regularPackages: Record<PetType, Package[]> = {
  dog: [
    { id: "dog-bath", name: "Essential Bath", detail: "Bath, shampoo, deshedding, blow dry & brushing", price: 1349, multiPrice: 1149 },
    { id: "dog-basic", name: "Bath & Basic", detail: "Complete bath care, nails, teeth, ears, eyes & minor trim", price: 1899, multiPrice: 1649, badge: "Best value" },
    { id: "dog-makeover", name: "Complete Makeover", detail: "Bath & Basic plus hair styling and full-body trimming", price: 2399, multiPrice: 2149 },
    { id: "dog-trim", name: "Just Trim", detail: "Haircut with nail clipping and ear cleaning", price: 1599, multiPrice: 1399 },
  ],
  cat: [
    { id: "cat-routine", name: "Routine Grooming", detail: "Nails, deshedding, teeth, ears, eyes, sanitary trim & combing", price: 1149, multiPrice: 999 },
    { id: "cat-basic", name: "Bath & Basic", detail: "Routine care plus bath, conditioning, massage, blow dry & minor trim", price: 1899, multiPrice: 1649, badge: "Best value" },
    { id: "cat-makeover", name: "Complete Makeover", detail: "Bath & Basic plus hair styling and full-body trimming", price: 2399, multiPrice: 2149 },
    { id: "cat-trim", name: "Just Trim", detail: "Haircut with nail clipping and ear cleaning", price: 1599, multiPrice: 1399 },
  ],
};

const youngPackages: Package[] = [
  { id: "young-basic", name: "Bath & Basic", detail: "Gentle complete grooming for pets up to 6 months", price: 999, multiPrice: 899, badge: "Puppy & kitten price" },
  { id: "young-makeover", name: "Complete Makeover", detail: "Gentle bath, hygiene care, styling and full-body trim", price: 1399, multiPrice: 1299 },
];

const subscriptionPackages: Package[] = [
  { id: "sub-3-dog", name: "3 sessions · Dog", detail: "Use within 4 months · ₹1,199/session", price: 3597 },
  { id: "sub-3-cat", name: "3 sessions · Cat Routine", detail: "Use within 4 months · flexible family wallet", price: 2999 },
  { id: "sub-6", name: "6 sessions", detail: "Use within 8 months · ₹1,099/session", price: 6594, badge: "Flexible" },
  { id: "sub-12", name: "12 sessions", detail: "Use within 15 months · ₹999/session", price: 11988, badge: "Lowest price" },
  { id: "sub-trim", name: "3 Just Trim sessions", detail: "Dogs & cats · use across registered family pets", price: 4197 },
];

// Taken from the flow that actually reserves the groomer. Listing a slot here that grooming-flow.tsx
// does not offer would advertise an appointment no booking can honour.
const slots = GROOMING_SLOTS;
const money = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value);

export default function Home() {
  const [customer, setCustomer] = useState<LoggedInCustomer | null>(null);
  const [booking, setBooking] = useState(false);
  // loadCustomerAccount() sends NO id: the server derives the subject from the platform session.
  useEffect(() => {
    let active = true;
    loadCustomerAccount()
      .then(record => { if (active) setCustomer({ customerId: record.customerId, customerName: record.name, phone: record.primaryPhone }); })
      .catch(() => { /* signed out: the booking control offers sign-in instead */ });
    return () => { active = false; };
  }, []);
  function startBooking() {
    if (customer) setBooking(true);
    else window.location.hash = "customer-login-modal";
  }
  function completeLogin(next: LoggedInCustomer) {
    setCustomer(next);
    if (window.location.hash === "#customer-login-modal") window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    setBooking(true);
  }
  const [petType, setPetType] = useState<PetType>("dog");
  const [offerType, setOfferType] = useState<OfferType>("regular");
  const [petCount, setPetCount] = useState(1);
  const [selectedPackage, setSelectedPackage] = useState<Package>(regularPackages.dog[1]);
  const [selectedDate, setSelectedDate] = useState(0);
  const [dates] = useState(() => groomingBookingDates());
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [toast] = useState("");
;

  const packages = offerType === "regular" ? regularPackages[petType] : offerType === "young" ? youngPackages : subscriptionPackages;

  const total = useMemo(() => {
    if (offerType === "subscription") return selectedPackage.price;
    if (petCount === 1) return selectedPackage.price;
    return (selectedPackage.multiPrice ?? selectedPackage.price) * petCount;
  }, [offerType, petCount, selectedPackage]);

  const duration = petCount <= 2 ? "2 hours" : petCount === 3 ? "2.5 hours" : "4 hours";
  const durationMinutes = petCount <= 2 ? 120 : petCount === 3 ? 150 : 240;

  function switchPet(type: PetType) {
    setPetType(type);
    if (offerType === "regular") setSelectedPackage(regularPackages[type][1]);
  }

  function switchOffer(type: OfferType) {
    setOfferType(type);
    const next = type === "regular" ? regularPackages[petType][1] : type === "young" ? youngPackages[0] : subscriptionPackages[3];
    setSelectedPackage(next);
    setSelectedSlot(null);
  }

  // What the customer just confirmed on the summary bar travels into the flow. A package with no
  // equivalent in the flow's catalogue (the subscription and young-pet offers) resolves to "" and the
  // flow keeps its own default rather than this page guessing a substitute.
  if (booking && customer) return <GroomingFlow customer={customer} initial={{
    type: petType,
    packId: resolveGroomingPackId(petType, selectedPackage.name),
    date: dates[selectedDate]?.isoDate,
    slot: selectedSlot ?? undefined,
  }} />;

  return (
    <main className="app-shell">
      {toast && <p className="toast-pill">✓ {toast}</p>}
      <header className="topbar">
        <img src="/assets/pawspace-logo.jpeg" alt="PawSpace" />
        <div className="location"><span>Doorstep grooming in</span><strong>📍 Bengaluru</strong></div>
        <div className="header-links"><Link href="/mobile-app">Mobile App</Link><Link href="/food">Fresh Food</Link><Link href="/boarding">Boarding</Link><Link href="/sitting">Pet Sitting</Link><Link href="/taxi">Pet Taxi</Link><Link href="/walking">Dog Walking</Link><Link href="/training">Training</Link><Link href="/mobile-app">My PawSpace</Link><Link href="/team">Team</Link>{customer ? <Link className="login-link" href="/mobile-app">{customer.customerName}</Link> : <a className="login-link" href="#customer-login-modal">Login</a>}</div>
      </header>
      <TestSyncPanel surface="customer" />

      {!customer && <div id="customer-login-modal" className="modal-backdrop customer-login-target" role="dialog" aria-modal="true" aria-label="Customer login">
        <div className="modal details-modal">
          <a className="modal-close" href="#" aria-label="Close customer login">×</a>
          <CustomerLogin embedded onLoggedIn={completeLogin} />
        </div>
      </div>}
      <style>{`.customer-login-target{display:none}.customer-login-target:target{display:grid}.customer-login-target .modal-close{display:grid;place-items:center;text-decoration:none}`}</style>

      <section className="hero">
        <div className="hero-copy">
          <span className="trust-chip">Bengaluru · canonical UAT booking</span>
          <h1>Grooming that comes <em>home.</em></h1>
          <p>Choose the care, pick a preferred slot and stay in control—from booking to your groomer’s arrival.</p>
          <div className="hero-benefits"><span>✓ One canonical booking record</span><span>✓ Verification shown when earned</span><span>✓ Payment status stays explicit</span></div>
        </div>
        <div className="hero-art"><div className="pet-orb"><span>🐶</span><span>🐱</span></div><div className="floating-note">At-home care<br/><strong>Happy pets.</strong></div></div>
      </section>

      <section className="booking-panel" id="book">
        <div className="section-heading"><div><p className="eyebrow">Build your booking</p><h2>Who are we grooming?</h2></div><span className="step-badge">1 of 3</span></div>
        <div className="pet-switch" role="group" aria-label="Pet type">
          <button className={petType === "dog" ? "active" : ""} onClick={() => switchPet("dog")}>🐶 Dog</button>
          <button className={petType === "cat" ? "active" : ""} onClick={() => switchPet("cat")}>🐱 Cat</button>
        </div>
        <div className="pet-count-row"><span>Number of pets</span><div className="count-picker">{[1,2,3,4].map(n => <button key={n} className={petCount === n ? "active" : ""} onClick={() => setPetCount(n)}>{n}</button>)}</div><strong>{duration} reserved</strong></div>

        <div className="offer-tabs">
          <button className={offerType === "regular" ? "active" : ""} onClick={() => switchOffer("regular")}>Packages</button>
          <button className={offerType === "young" ? "active" : ""} onClick={() => switchOffer("young")}>Puppy & kitten</button>
          <button className={offerType === "subscription" ? "active" : ""} onClick={() => switchOffer("subscription")}>Subscriptions</button>
        </div>

        <div className="package-grid">
          {packages.map(pkg => {
            const selected = selectedPackage.id === pkg.id;
            return <button key={pkg.id} className={`package-card ${selected ? "selected" : ""}`} onClick={() => setSelectedPackage(pkg)}>
              <div>{pkg.badge && <span className="package-badge">{pkg.badge}</span>}<span className="radio-dot">{selected ? "✓" : ""}</span></div>
              <h3>{pkg.name}</h3><p>{pkg.detail}</p>
              <strong>{money(pkg.price)}{offerType !== "subscription" && <small> / pet</small>}</strong>
              {petCount > 1 && pkg.multiPrice && <span className="saving">Multi-pet price {money(pkg.multiPrice)} each</span>}
            </button>;
          })}
        </div>
        {offerType !== "subscription" && <div className="addons-strip"><span>Popular add-ons</span><strong>Tick & flea ₹499</strong><strong>Oil massage ₹299</strong><em>Add during service</em></div>}
      </section>

      <section className="booking-panel slots-panel">
        <div className="section-heading"><div><p className="eyebrow">Grooming schedule</p><h2>Choose your time</h2></div><span className="step-badge">2 of 3</span></div>
        <p className="muted">No login needed to browse. Provider capacity and zone availability are checked when you confirm the booking.</p>
        <div className="date-row">{dates.map((d, index) => <button key={d.isoDate} className={selectedDate === index ? "active" : ""} onClick={() => { setSelectedDate(index); setSelectedSlot(null); }}><span>{d.day}</span><strong>{d.date}</strong></button>)}</div>
        <div className="slots-grid">{slots.map((slot, index) => {
          const withinRoster = groomingSlotFitsRoster(index, durationMinutes);
          return <button key={slot} disabled={!withinRoster} className={selectedSlot === slot ? "selected" : ""} onClick={() => setSelectedSlot(slot)}><span>{slot}</span><small>{withinRoster ? "Availability checked at confirmation" : "Outside service hours"}</small></button>;
        })}</div>
      </section>

      <aside className="checkout-bar">
        <div><span>{selectedPackage.name} · {petCount} {petCount === 1 ? "pet" : "pets"}</span><strong>{money(total)}</strong><small>{selectedSlot ? `${dates[selectedDate].date} · ${selectedSlot}` : "Select a slot to continue"}</small></div>
        <button disabled={!selectedSlot} onClick={startBooking}>Confirm booking →</button>
      </aside>

      
          </main>
  );
}