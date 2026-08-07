"use client";
/* eslint-disable @next/next/no-img-element */

import { FormEvent, useMemo, useState } from "react";
import Link from "next/link";
import TestSyncPanel from "./components/test-sync-panel";

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

type SavedPet = { id: string; name: string; type: PetType; breed: string; age: string };

const savedPets: SavedPet[] = [
  { id: "bruno", name: "Bruno", type: "dog", breed: "Golden Retriever", age: "4 years" },
  { id: "milo", name: "Milo", type: "dog", breed: "Shih Tzu", age: "2 years" },
  { id: "max", name: "Max", type: "dog", breed: "Labrador", age: "5 years" },
  { id: "rio", name: "Rio", type: "dog", breed: "Indie", age: "1 year" },
  { id: "coco", name: "Coco", type: "cat", breed: "Persian", age: "3 years" },
  { id: "luna", name: "Luna", type: "cat", breed: "Domestic Shorthair", age: "2 years" },
  { id: "simba", name: "Simba", type: "cat", breed: "Maine Coon", age: "4 years" },
  { id: "oreo", name: "Oreo", type: "cat", breed: "Persian", age: "1 year" },
];

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

const slots = ["9:00–11:00 AM", "11:00 AM–1:00 PM", "1:00–3:00 PM", "3:00–5:00 PM", "5:00–7:00 PM"];
const dates = [
  { day: "Today", date: "3 Aug" },
  { day: "Tue", date: "4 Aug" },
  { day: "Wed", date: "5 Aug" },
  { day: "Thu", date: "6 Aug" },
];

const money = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value);

export default function Home() {
  const [petType, setPetType] = useState<PetType>("dog");
  const [offerType, setOfferType] = useState<OfferType>("regular");
  const [petCount, setPetCount] = useState(1);
  const [selectedPackage, setSelectedPackage] = useState<Package>(regularPackages.dog[1]);
  const [selectedDate, setSelectedDate] = useState(0);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [showOtp, setShowOtp] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [phone, setPhone] = useState("");
  const [payment, setPayment] = useState("after");
  const [trainingLead, setTrainingLead] = useState(false);
  const [petDropdownOpen, setPetDropdownOpen] = useState(false);
  const [selectedPetIds, setSelectedPetIds] = useState<string[]>(["bruno"]);
  const [petSelectionError, setPetSelectionError] = useState("");

  const packages = offerType === "regular" ? regularPackages[petType] : offerType === "young" ? youngPackages : subscriptionPackages;

  const total = useMemo(() => {
    if (offerType === "subscription") return selectedPackage.price;
    if (petCount === 1) return selectedPackage.price;
    return (selectedPackage.multiPrice ?? selectedPackage.price) * petCount;
  }, [offerType, petCount, selectedPackage]);

  const duration = petCount <= 2 ? "2 hours" : petCount === 3 ? "2.5 hours" : "4 hours";

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

  function verifyOtp(event: FormEvent) {
    event.preventDefault();
    if (phone.replace(/\D/g, "").length < 10) return;
    const matchingPets = savedPets.filter((pet) => pet.type === petType).slice(0, petCount).map((pet) => pet.id);
    setSelectedPetIds(matchingPets);
    setPetSelectionError("");
    setShowOtp(false);
    setShowDetails(true);
  }

  function finishBooking(event: FormEvent) {
    event.preventDefault();
    if (selectedPetIds.length !== petCount) {
      setPetSelectionError(`Please select exactly ${petCount} ${petCount === 1 ? "pet" : "pets"} for this booking.`);
      return;
    }
    setShowDetails(false);
    setConfirmed(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function toggleSavedPet(id: string) {
    setPetSelectionError("");
    setSelectedPetIds((current) => {
      if (current.includes(id)) return current.filter((petId) => petId !== id);
      if (current.length >= petCount) return current;
      return [...current, id];
    });
  }

  const selectedPetNames = selectedPetIds.map((id) => savedPets.find((pet) => pet.id === id)?.name).filter(Boolean).join(", ");

  if (confirmed) {
    return (
      <main className="app-shell confirmation-shell">
        <header className="topbar compact"><img src="/assets/pawspace-logo.jpeg" alt="PawSpace" /><span className="secure-pill">✓ Booking confirmed</span></header>
        <TestSyncPanel surface="customer" />
        <section className="confirmation-card">
          <div className="success-mark">✓</div>
          <p className="eyebrow">You’re all set</p>
          <h1>Grooming booked.</h1>
          <p className="muted">Your pet’s doorstep grooming is confirmed for <strong>{dates[selectedDate].date}, {selectedSlot}</strong>.</p>
          <div className="groomer-card">
            <div className="avatar">AR</div>
            <div><strong>Arun R.</strong><span>4.9 ★ · 1,248 services · 4 years with PawSpace</span></div>
            <button type="button">Message</button>
          </div>
          <div className="booking-summary">
            <div><span>Package</span><strong>{selectedPackage.name}</strong></div>
            <div><span>{petCount === 1 ? "Pet" : "Pets"}</span><strong>{selectedPetNames || petCount}</strong></div>
            <div><span>Duration</span><strong>{duration}</strong></div>
            <div><span>Payment</span><strong>{payment === "after" ? "Pay after service" : "Paid online"}</strong></div>
            <div className="summary-total"><span>Total</span><strong>{money(total)}</strong></div>
          </div>
          <div className="status-rail"><span className="done">Confirmed</span><i></i><span>On the way</span><i></i><span>Arrived</span><i></i><span>Completed</span></div>
          {offerType === "young" && petType === "dog" && (
            <div className="training-card">
              <div className="training-icon">🎓</div>
              <div><p className="eyebrow">Perfect time to start</p><h2>Does your puppy need doorstep training?</h2><p>Get help with toilet training, biting, obedience, leash walking and socialisation.</p></div>
              <button className={trainingLead ? "secondary-button selected" : "primary-button"} onClick={() => setTrainingLead(true)}>{trainingLead ? "✓ Consultation requested" : "Get a free consultation"}</button>
            </div>
          )}
          <div className="confirmation-actions"><button className="secondary-button">Add to calendar</button><button className="primary-button" onClick={() => setConfirmed(false)}>View booking</button></div>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <img src="/assets/pawspace-logo.jpeg" alt="PawSpace" />
        <div className="location"><span>Doorstep grooming in</span><strong>📍 Bengaluru</strong></div>
        <div className="header-links"><Link href="/mobile-app">Mobile App</Link><Link href="/food">Fresh Food</Link><Link href="/boarding">Boarding</Link><Link href="/sitting">Pet Sitting</Link><Link href="/taxi">Pet Taxi</Link><Link href="/walking">Dog Walking</Link><Link href="/training">Training</Link><Link href="/account">My PawSpace</Link><Link href="/team">Team</Link><button className="login-link" onClick={() => setShowOtp(true)}>Login</button></div>
      </header>
      <TestSyncPanel surface="customer" />

      <section className="hero">
        <div className="hero-copy">
          <span className="trust-chip">★ 4.5 · 2,000+ Google reviews</span>
          <h1>Grooming that comes <em>home.</em></h1>
          <p>Choose the care, pick a live slot and stay in control—from booking to your groomer’s arrival.</p>
          <div className="hero-benefits"><span>✓ 50,000+ pet parents</span><span>✓ Verified groomers</span><span>✓ Pay your way</span></div>
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
        <div className="section-heading"><div><p className="eyebrow">Live groomer calendar</p><h2>Choose your time</h2></div><span className="step-badge">2 of 3</span></div>
        <p className="muted">No login needed to browse. These slots update automatically from groomer calendars in your Bengaluru service zone.</p>
        <div className="date-row">{dates.map((d, index) => <button key={d.date} className={selectedDate === index ? "active" : ""} onClick={() => {setSelectedDate(index); setSelectedSlot(null);}}><span>{d.day}</span><strong>{d.date}</strong></button>)}</div>
        <div className="slots-grid">{slots.map((slot, index) => {
          const unavailable = (selectedDate === 0 && index === 0) || (petCount === 4 && index % 2 === 1);
          return <button key={slot} disabled={unavailable} className={selectedSlot === slot ? "selected" : ""} onClick={() => setSelectedSlot(slot)}><span>{slot}</span>{unavailable ? <small>Unavailable</small> : <small>{index % 2 === 0 ? "2 groomers" : "1 groomer"}</small>}</button>;
        })}</div>
      </section>

      <aside className="checkout-bar">
        <div><span>{selectedPackage.name} · {petCount} {petCount === 1 ? "pet" : "pets"}</span><strong>{money(total)}</strong><small>{selectedSlot ? `${dates[selectedDate].date} · ${selectedSlot}` : "Select a live slot to continue"}</small></div>
        <button disabled={!selectedSlot} onClick={() => setShowOtp(true)}>Confirm booking →</button>
      </aside>

      {showOtp && <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowOtp(false)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="otp-title" onMouseDown={e => e.stopPropagation()}>
        <button className="modal-close" onClick={() => setShowOtp(false)} aria-label="Close">×</button><div className="modal-icon">📱</div>
        <p className="eyebrow">Almost booked</p><h2 id="otp-title">Confirm your mobile number</h2><p>We’ll use it for booking updates, payment details and groomer tracking.</p>
        <form onSubmit={verifyOtp}><label>Primary mobile number</label><div className="phone-input"><span>+91</span><input value={phone} onChange={e => setPhone(e.target.value)} inputMode="numeric" placeholder="99969 99505" autoFocus /></div><button className="primary-button" type="submit">Send & verify OTP</button></form>
        <small>Prototype note: OTP verification is simulated for review.</small>
      </section></div>}

      {showDetails && <div className="modal-backdrop details-backdrop"><section className="modal details-modal" role="dialog" aria-modal="true"><button className="modal-close" onClick={() => setShowDetails(false)} aria-label="Close">×</button>
        <p className="eyebrow">Final details</p><h2>Tell us where to come</h2><form onSubmit={finishBooking} className="details-form">
          <div className="field-row"><label>Customer name<input required placeholder="Your name" /></label><label>Secondary number<input required inputMode="numeric" placeholder="Alternative contact" /></label></div>
          <label>Doorstep address<input required placeholder="Search Bengaluru address or use current location" /></label>
          <div className="pet-select-wrap">
            <label>Select {petCount} registered {petCount === 1 ? "pet" : "pets"}</label>
            <button type="button" className={`pet-select-trigger ${petDropdownOpen ? "open" : ""}`} onClick={() => setPetDropdownOpen((open) => !open)} aria-expanded={petDropdownOpen}>
              <span>{selectedPetNames || "Choose from your saved pets"}</span><strong>{selectedPetIds.length}/{petCount} selected⌄</strong>
            </button>
            {petDropdownOpen && <div className="pet-dropdown">
              {savedPets.filter((pet) => pet.type === petType).map((pet) => {
                const checked = selectedPetIds.includes(pet.id);
                const disabled = !checked && selectedPetIds.length >= petCount;
                return <button type="button" key={pet.id} disabled={disabled} className={checked ? "selected" : ""} onClick={() => toggleSavedPet(pet.id)}>
                  <span className="pet-avatar">{pet.type === "dog" ? "🐶" : "🐱"}</span><span><strong>{pet.name}</strong><small>{pet.breed} · {pet.age}</small></span><i>{checked ? "✓" : ""}</i>
                </button>;
              })}
              <button type="button" className="add-pet-option"><span className="pet-avatar">＋</span><span><strong>Add a new pet</strong><small>Create another pet profile</small></span><i>→</i></button>
            </div>}
            {petSelectionError && <p className="field-error">{petSelectionError}</p>}
          </div>
          <label>Safety notes<select defaultValue="friendly"><option value="friendly">Friendly / comfortable with grooming</option><option value="anxious">Anxious or first grooming</option><option value="aggressive">Aggressive / bite history</option></select></label>
          <fieldset><legend>Payment preference</legend><label className={payment === "online" ? "payment-choice active" : "payment-choice"}><input type="radio" name="payment" value="online" checked={payment === "online"} onChange={() => setPayment("online")} /><span>Pay online now<small>UPI, card or net banking</small></span></label><label className={payment === "after" ? "payment-choice active" : "payment-choice"}><input type="radio" name="payment" value="after" checked={payment === "after"} onChange={() => setPayment("after")} /><span>Pay after service<small>Dynamic Razorpay QR, UPI or cash</small></span></label></fieldset>
          <div className="mini-summary"><span>Total due</span><strong>{money(total)}</strong></div><button className="primary-button" type="submit">Confirm instantly</button>
        </form>
      </section></div>}
    </main>
  );
}
