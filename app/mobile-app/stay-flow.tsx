"use client";
/* eslint-disable @next/next/no-img-element */
import { useState } from "react";
import styles from "./stay-flow.module.css";
import { createTestTransaction } from "../../lib/test-transaction";
import ProviderTrackingCard from "./provider-tracking-card";
import CouponField from "./coupon-field";
import { reserveUatSchedule } from "../../lib/uat-scheduling-client";
import { createCanonicalLifecycle } from "../../lib/canonical-lifecycle-client";

type Mode = "boarding" | "sitting";
type View = "stay" | "care" | "support";
type CareWindow = "4 hours" | "12 hours" | "24 hours";
type Caregiver = {
  name: string;
  initials: string;
  area: string;
  rating: string;
  reviews: number;
  repeat: number;
  price: number;
  match: string;
  badge: string;
  response: string;
  home: string;
  features: string[];
  capacity: string;
};
const boardingHosts: Caregiver[] = [
  {
    name: "Maya & Rohan",
    initials: "MR",
    area: "Indiranagar",
    rating: "4.9",
    reviews: 184,
    repeat: 63,
    price: 1299,
    match: "98%",
    badge: "PawSpace Elite",
    response: "Usually confirms in 8 min",
    home: "Calm, pet-only home with a fenced terrace",
    features: ["24/7 supervision", "Home inspected", "Daily photo updates"],
    capacity: "2 guest pets · one family at a time",
  },
  {
    name: "Sana F.",
    initials: "SF",
    area: "HSR Layout",
    rating: "5.0",
    reviews: 96,
    repeat: 41,
    price: 1499,
    match: "96%",
    badge: "Top repeat host",
    response: "Usually confirms in 5 min",
    home: "Quiet independent home with no resident pets",
    features: ["Dogs & cats", "Medication support", "Pickup available"],
    capacity: "2 guest pets · dogs and cats",
  },
  {
    name: "Arjun & Tara",
    initials: "AT",
    area: "Koramangala",
    rating: "4.8",
    reviews: 212,
    repeat: 78,
    price: 1099,
    match: "91%",
    badge: "Social-pet favourite",
    response: "Usually confirms in 14 min",
    home: "Lively home with a garden and resident beagle",
    features: ["Long walks", "Secure garden", "Camera updates"],
    capacity: "3 guest dogs · up to 20 kg",
  },
];
const sitters: Caregiver[] = [
  {
    name: "Sana F.",
    initials: "SF",
    area: "HSR Layout",
    rating: "5.0",
    reviews: 96,
    repeat: 41,
    price: 899,
    match: "97%",
    badge: "PawSpace Elite",
    response: "Available now",
    home: "Overnight care in your home",
    features: ["Dogs & cats", "Medication support", "GPS check-in"],
    capacity: "Up to 4 pets from one family",
  },
  {
    name: "Neha P.",
    initials: "NP",
    area: "Indiranagar",
    rating: "4.9",
    reviews: 148,
    repeat: 58,
    price: 799,
    match: "94%",
    badge: "Top repeat sitter",
    response: "Replies in 6 min",
    home: "Calm overnight and multi-pet specialist",
    features: ["Multiple pets", "Senior care", "Two daily walks"],
    capacity: "Up to 4 pets from one family",
  },
  {
    name: "Asha R.",
    initials: "AR",
    area: "Koramangala",
    rating: "4.8",
    reviews: 112,
    repeat: 37,
    price: 699,
    match: "90%",
    badge: "Fast responder",
    response: "Replies in 9 min",
    home: "Home visits and cat-care specialist",
    features: ["Cats", "Plant care", "Live Care Cards"],
    capacity: "Up to 3 pets from one family",
  },
];
const pets = [
  { name: "Bruno", detail: "Golden Retriever · 4 years", icon: "🐕" },
  { name: "Coco", detail: "Persian cat · 3 years", icon: "🐈" },
  { name: "Milo", detail: "Beagle · 2 years", icon: "🐶" },
];
const needs = [
  "24/7 supervision",
  "Medication",
  "Two daily walks",
  "No resident pets",
  "Senior care",
  "One family only",
];
const careBenefits = [
  "Pickup & drop",
  "Three walks",
  "Medication support",
  "1-hour play time",
  "Grooming add-on",
  "Training add-on",
];
const money = (n: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);
const shortDate = (value: string) =>
  new Date(`${value}T00:00:00`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
  });

export default function StayFlow({ mode: initialMode }: { mode: Mode }) {
  const [mode, setMode] = useState<Mode>(initialMode),
    [stage, setStage] = useState(1),
    [selectedPets, setSelectedPets] = useState(["Bruno", "Coco"]),
    [selectedNeeds, setSelectedNeeds] = useState([
      "Medication",
      "Two daily walks",
    ]),
    [selectedBenefits, setSelectedBenefits] = useState([
      "Three walks",
      "Medication support",
      "1-hour play time",
    ]),
    [careWindow, setCareWindow] = useState<CareWindow>("24 hours"),
    [foodType, setFoodType] = useState("Pet food from home"),
    [pricing, setPricing] = useState("Best available offer"),
    [caregiver, setCaregiver] = useState(
      (initialMode === "boarding" ? boardingHosts : sitters)[0],
    ),
    [meet, setMeet] = useState(true),
    [meetFormat, setMeetFormat] = useState<"visit" | "call">("visit"),
    [taxi, setTaxi] = useState(initialMode === "boarding"),
    [confirmed, setConfirmed] = useState(false),
    [agreed, setAgreed] = useState(true),
    [start, setStart] = useState("2026-08-24"),
    [end, setEnd] = useState("2026-08-31"),
    [bookingId, setBookingId] = useState(""),
    [scheduling, setScheduling] = useState(false),
    [scheduleError, setScheduleError] = useState(""),
    [profileOpen, setProfileOpen] = useState(true),
    [splitPayment, setSplitPayment] = useState(true),
    [discount, setDiscount] = useState(0),
    [couponCode, setCouponCode] = useState(""),
    [chatOpen, setChatOpen] = useState(false),
    [view, setView] = useState<View>("stay");
  const caregivers = mode === "boarding" ? boardingHosts : sitters;
  const nights = Math.max(
    0,
    Math.ceil(
      (new Date(`${end}T00:00:00`).getTime() -
        new Date(`${start}T00:00:00`).getTime()) /
        86_400_000,
    ),
  );
  const datesValid = careWindow === "24 hours" ? nights > 0 : Boolean(start);
  const durationMultiplier = careWindow === "4 hours" ? 0.4 : careWindow === "12 hours" ? 0.7 : nights;
  const extraPets = Math.max(0, selectedPets.length - 1);
  const base = Math.round(caregiver.price * durationMultiplier);
  const extra = Math.round(extraPets * (mode === "boarding" ? 699 : 399) * durationMultiplier);
  const protection = 249;
  const taxiFee = taxi && mode === "boarding" ? 499 : 0;
  const stayTotal = base + extra + protection + taxiFee;
  const meetFee = meet && mode === "sitting" && meetFormat === "visit" ? 500 : 0;
  const totalBeforeCoupon = stayTotal + meetFee;
  const total = Math.max(0, totalBeforeCoupon - discount);
  const splitEligible = careWindow === "24 hours" && nights > 5;
  const discountedStay = Math.max(0, stayTotal - discount);
  const reserveAmount = splitEligible && splitPayment
    ? Math.ceil(discountedStay / 2) + meetFee
    : total;
  const balanceAmount = splitEligible && splitPayment
    ? discountedStay - Math.ceil(discountedStay / 2)
    : 0;
  const togglePet = (name: string) =>
    setSelectedPets((current) =>
      current.includes(name)
        ? current.length === 1
          ? current
          : current.filter((p) => p !== name)
        : current.length < 4
          ? [...current, name]
          : current,
    );
  const toggleNeed = (need: string) =>
    setSelectedNeeds((current) =>
      current.includes(need)
        ? current.filter((n) => n !== need)
        : [...current, need],
    );
  const toggleBenefit = (benefit: string) =>
    setSelectedBenefits((current) =>
      current.includes(benefit)
        ? current.filter((item) => item !== benefit)
        : [...current, benefit],
    );
  const switchMode = (next: Mode) => {
    setMode(next);
    setCaregiver((next === "boarding" ? boardingHosts : sitters)[0]);
    setTaxi(next === "boarding");
    setProfileOpen(true);
  };
  const confirm = async () => {
    if (!datesValid || !agreed) return;
    setScheduling(true);setScheduleError("");
    try {
    const scheduleStart=new Date(`${start}T03:30:00.000Z`);const scheduleEnd=careWindow==="24 hours"?new Date(`${end}T03:30:00.000Z`):new Date(scheduleStart.getTime()+(careWindow==="12 hours"?12:4)*3_600_000);const providerIds:Record<string,string>={"Maya & Rohan":"host_maya_rohan","Sana F.":mode==="boarding"?"host_sana":"sit_sana","Neha P.":"sit_neha"};const requestId=`${mode}-TST101-${start}-${end}-${careWindow.replaceAll(" ","")}-${selectedPets.length}`;const decision=await reserveUatSchedule({clientRequestId:requestId,customerId:"TST-101",petIds:selectedPets,serviceCode:mode==="boarding"?"boarding":"pet_sitting",zoneId:"blr-east",scheduledStart:scheduleStart.toISOString(),scheduledEnd:scheduleEnd.toISOString(),careMode:careWindow==="24 hours"?"overnight":"visit",preferredProviderId:providerIds[caregiver.name]});
    const canonical=await createCanonicalLifecycle({idempotencyKey:requestId,scheduleGroupId:decision.groupId,customer:{id:"TST-101",name:"Karthik P.",primaryPhone:"9996999505",secondaryPhone:"9880222741"},pets:selectedPets.map(name=>({sourceId:name,name,species:name==="Coco"?"cat":"dog",vaccinationStatus:mode==="boarding"?"verified":"not_provided"})),cityId:"blr",zoneId:"blr-east",serviceCode:mode==="boarding"?"boarding":"pet_sitting",packageCode:mode==="boarding"?"home-boarding":careWindow==="24 hours"?"overnight-sitting":"home-visit",packageName:mode==="boarding"?"Home Boarding":"Pet Sitting",scheduledStart:scheduleStart.toISOString(),scheduledEnd:scheduleEnd.toISOString(),provider:decision.provider,totalAmount:total,amountDueNow:reserveAmount,payment:{method:"upi",mode:splitEligible&&splitPayment?"split":"prepaid",status:"captured",detail:splitEligible&&splitPayment?"UAT 50% stay deposit captured":"UAT payment captured"},pricing:{discount,couponCode:couponCode||undefined}});
    const booking = createTestTransaction({
      customerId: "TST-101",
      customerName: "Karthik P.",
      primary: "9996999505",
      secondary: "9880222741",
      pets: selectedPets.join(", "),
      petCount: selectedPets.length,
      service: mode === "boarding" ? "Boarding" : "Pet Sitting",
      packageName:
        mode === "boarding" ? "Home Boarding" : "Overnight Pet Sitting",
      area: caregiver.area,
      slot:
        careWindow === "24 hours"
          ? `${shortDate(start)}–${shortDate(end)}`
          : `${shortDate(start)} · ${careWindow}`,
      duration: careWindow === "24 hours" ? `${nights} nights` : careWindow,
      amount: total,
      offerCode: couponCode || undefined,
      discount,
      payment:
        splitEligible && splitPayment
          ? `50% stay deposit + Meet & Greet paid · ${money(balanceAmount)} due 24 hours before check-in`
          : `Paid online in full${couponCode ? ` · Coupon ${couponCode}` : ""}`,
      provider: decision.provider.name,
      providerModel: "Commission",
      subscription: "No active plan",
      creditsBefore: 0,
      crmOwner: "Asha",
      crmNextAction: "Commission caregiver approval, secure chat and Meet & Greet",
      reminder: "Care Card and emergency-contact updates queued",
    },canonical.bookingId);
    setBookingId(booking.id);
    setConfirmed(true);
    } catch(error){setScheduleError(error instanceof Error?error.message:"No host or sitter is available for the full care window");} finally {setScheduling(false);}
  };
  if (confirmed)
    return (
      <LiveStay
        bookingId={bookingId}
        start={start}
        end={end}
        nights={nights}
        mode={mode}
        caregiver={caregiver}
        pets={selectedPets}
        total={total}
        taxi={taxi}
        view={view}
        setView={setView}
      />
    );
  return (
    <section className={styles.flow}>
      <div className={styles.steps}>
        {[1, 2, 3, 4].map((n) => (
          <span key={n} className={stage >= n ? styles.active : ""}>
            {n}
          </span>
        ))}
      </div>
      {stage === 1 && (
        <>
          <Head title="Plan their care" note="Trip · 1 of 4" />
          <div className={styles.modeSwitch}>
            <button
              className={mode === "boarding" ? styles.selected : ""}
              onClick={() => switchMode("boarding")}
            >
              <i>⌂</i>
              <b>Home Boarding</b>
              <span>Pets stay in a verified host home</span>
            </button>
            <button
              className={mode === "sitting" ? styles.selected : ""}
              onClick={() => switchMode("sitting")}
            >
              <i>♡</i>
              <b>Pet Sitting</b>
              <span>A sitter cares for pets at your home</span>
            </button>
          </div>
          <div className={styles.sectionHead}>
            <b>Care duration</b>
            <span>Choose one</span>
          </div>
          <div className={styles.careWindows}>
            {(["4 hours", "12 hours", "24 hours"] as CareWindow[]).map((window) => (
              <button
                key={window}
                className={careWindow === window ? styles.selected : ""}
                onClick={() => setCareWindow(window)}
              >
                <b>{window}</b>
                <small>
                  {window === "4 hours"
                    ? "Short care"
                    : window === "12 hours"
                      ? "Day or night"
                      : "Overnight / multi-day"}
                </small>
              </button>
            ))}
          </div>
          <label className={styles.field}>
            Bengaluru area
            <select>
              <option>Indiranagar</option>
              <option>Koramangala</option>
              <option>HSR Layout</option>
              <option>Whitefield</option>
              <option>JP Nagar</option>
            </select>
          </label>
          <div className={careWindow === "24 hours" ? styles.datePair : styles.singleDate}>
            <label className={styles.field}>
              Start
              <input
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            {careWindow === "24 hours" && (
              <label className={styles.field}>
                End
                <input
                  type="date"
                  value={end}
                  min={start}
                  onChange={(e) => setEnd(e.target.value)}
                />
              </label>
            )}
          </div>
          {careWindow !== "24 hours" && (
            <label className={styles.field}>
              Start time
              <select defaultValue="9:00 AM">
                <option>9:00 AM</option>
                <option>1:00 PM</option>
                <option>6:00 PM</option>
              </select>
            </label>
          )}
          <div className={styles.sectionHead}>
            <b>Select pets</b>
            <span>{selectedPets.length} of 4</span>
          </div>
          <div className={styles.petList}>
            {pets.map((p) => (
              <button
                key={p.name}
                className={selectedPets.includes(p.name) ? styles.selected : ""}
                onClick={() => togglePet(p.name)}
              >
                <i>{p.icon}</i>
                <span>
                  <b>{p.name}</b>
                  <small>{p.detail}</small>
                </span>
                <em>{selectedPets.includes(p.name) ? "✓" : "＋"}</em>
              </button>
            ))}
            <button className={styles.addPet}>
              <i>＋</i>
              <span>
                <b>Add another pet</b>
                <small>Create pet profile</small>
              </span>
            </button>
          </div>
          <div className={styles.sectionHead}>
            <b>Care needs</b>
            <span>Optional</span>
          </div>
          <div className={styles.chips}>
            {needs.map((n) => (
              <button
                key={n}
                className={selectedNeeds.includes(n) ? styles.selected : ""}
                onClick={() => toggleNeed(n)}
              >
                {selectedNeeds.includes(n) ? "✓ " : "＋ "}
                {n}
              </button>
            ))}
          </div>
          <p className={styles.hint}>
            {datesValid
              ? `${careWindow === "24 hours" ? `${nights} nights` : careWindow} selected · request goes to eligible commission partners within 15 km.`
              : "End date must be after the start date."}
          </p>
          <button
            disabled={!datesValid}
            className={styles.primary}
            onClick={() => setStage(2)}
          >
            See available {mode === "boarding" ? "homes" : "sitters"}
          </button>
        </>
      )}
      {stage === 2 && (
        <>
          <Head
            title={`Choose your ${mode === "boarding" ? "host" : "sitter"}`}
            note="Match · 2 of 4"
          />
          <article className={styles.matchIntro}>
            <i>✦</i>
            <div>
              <b>Request shared within a 15 km service radius</b>
              <span>
                Verified commission partners receive the request, review the
                Care Card and send an acceptance or flexible offer.
              </span>
            </div>
          </article>
          <label className={styles.field}>
            Pricing preference
            <select value={pricing} onChange={(e) => setPricing(e.target.value)}>
              <option>Best available offer</option>
              <option>Fixed PawSpace rate only</option>
              <option>Premium-care offers welcome</option>
            </select>
          </label>
          <div className={styles.offerStatus}>
            <span><b>3</b> eligible partners</span>
            <span><b>2</b> accepted</span>
            <span><b>1</b> flexible offer</span>
          </div>
          <div className={styles.caregivers}>
            {caregivers.map((c, i) => (
              <button
                key={c.name}
                className={caregiver.name === c.name ? styles.selected : ""}
                onClick={() => {
                  setCaregiver(c);
                  setProfileOpen(true);
                }}
              >
                <div className={styles.caregiverTop}>
                  {i === 0 ? (
                    <img
                      src={
                        mode === "boarding"
                          ? "/assets/stays/maya-rohan-profile.webp"
                          : "/assets/stays/sitter-profile.webp"
                      }
                      alt={c.name + " test profile"}
                    />
                  ) : (
                    <i>{c.initials}</i>
                  )}
                  <div>
                    <span>{c.badge}</span>
                    <h4>{c.name}</h4>
                  <small>
                      📍 {c.area} · {(i + 1) * 3.2} km · {c.response}
                  </small>
                  </div>
                  <em>
                    {c.match}
                    <small>match</small>
                  </em>
                </div>
                <p>{c.home}</p>
                <div className={styles.tags}>
                  {c.features.map((f) => (
                    <span key={f}>✓ {f}</span>
                  ))}
                </div>
                <div className={styles.caregiverFoot}>
                  <span>
                    <b>{c.rating} ★</b>
                    {c.reviews} reviews · {c.repeat} repeats
                  </span>
                  <strong>
                    {money(c.price)}
                    <small> / night</small>
                  </strong>
                </div>
                {i < 2 && (
                  <label>
                    ✓ Partner accepted · live calendar verified
                  </label>
                )}
                {i === 2 && <label>Flexible offer · awaiting your response</label>}
              </button>
            ))}
          </div>
          <article className={styles.profileNote}>
            <div>
              <b>
                {caregiver.name} · {caregiver.capacity}
              </b>
              <span>
                Photos, reviews, amenities, calendar and care rules are managed
                from the {mode === "boarding" ? "Host" : "Sitter"} Partner App.
              </span>
            </div>
            <button onClick={() => setProfileOpen((open) => !open)}>
              {profileOpen ? "Hide profile" : "View full profile"}
            </button>
            <button onClick={() => setChatOpen((open) => !open)}>
              {chatOpen ? "Close chat" : "Chat securely"}
            </button>
          </article>
          {chatOpen && (
            <article className={styles.secureChat}>
              <header><b>Chat with {caregiver.name}</b><span>Numbers stay masked</span></header>
              <p><b>{caregiver.name.split(" ")[0]}:</b> I can support medication, three walks and the one-hour play routine.</p>
              <p><b>You:</b> Can you also arrange pickup and share a flexible all-inclusive price?</p>
              <label><input placeholder="Type a message" /><button>Send</button></label>
            </article>
          )}
          {profileOpen && (
            <CaregiverProfile
              mode={mode}
              caregiver={caregiver}
              start={start}
              end={end}
            />
          )}
          <button className={styles.back} onClick={() => setStage(1)}>
            ← Trip details
          </button>
          <button className={styles.primary} onClick={() => setStage(3)}>
            Continue with {caregiver.name.split(" ")[0]}
          </button>
        </>
      )}
      {stage === 3 && (
        <>
          <Head title="Build the Care Card" note="Instructions · 3 of 4" />
          <article className={styles.careHero}>
            <i>{mode === "boarding" ? "🏡" : "🔐"}</i>
            <div>
              <b>
                {mode === "boarding"
                  ? "Their routine travels with them"
                  : "Your home access stays private"}
              </b>
              <span>
                {mode === "boarding"
                  ? "The host receives one approved care plan for every pet."
                  : "Access is revealed only to the confirmed sitter shortly before check-in."}
              </span>
            </div>
          </article>
          <div className={styles.sectionHead}>
            <b>Care benefits & add-ons</b>
            <span>Shared with partner</span>
          </div>
          <div className={styles.benefitGrid}>
            {careBenefits.map((benefit) => (
              <button
                key={benefit}
                className={selectedBenefits.includes(benefit) ? styles.selected : ""}
                onClick={() => toggleBenefit(benefit)}
              >
                {selectedBenefits.includes(benefit) ? "✓" : "＋"} {benefit}
              </button>
            ))}
          </div>
          <label className={styles.field}>
            Food preference
            <select value={foodType} onChange={(e) => setFoodType(e.target.value)}>
              <option>Pet food from home</option>
              <option>Vegetarian fresh food</option>
              <option>Non-vegetarian fresh food</option>
              <option>Host/sitter to quote food separately</option>
            </select>
          </label>
          <label className={styles.field}>
            Special request
            <textarea defaultValue="Please keep Bruno separate during meals and share one play-time video daily." />
          </label>
          <label className={styles.field}>
            Food & water routine
            <textarea defaultValue="Bruno: meals at 7:30 AM and 6:30 PM. Coco: wet food at 8 AM and 7 PM." />
          </label>
          <label className={styles.field}>
            Walk, toilet & sleep routine
            <textarea defaultValue="Bruno needs two 30-minute walks. Coco sleeps in the living room." />
          </label>
          <label className={styles.field}>
            Medication, allergies & vet
            <textarea defaultValue="Bruno: one tablet after breakfast. Vet: Cessna Lifeline, Domlur." />
          </label>
          {mode === "sitting" && (
            <label className={styles.field}>
              Secure home access
              <select>
                <option>Key handover during Meet & Greet</option>
                <option>Building staff access</option>
                <option>Time-limited digital lock code</option>
              </select>
            </label>
          )}
          <div className={styles.contacts}>
            <label className={styles.field}>
              Primary contact
              <input defaultValue="Karthik · +91 99969 99505" />
            </label>
            <label className={styles.field}>
              Secondary contact
              <input defaultValue="Rahul · +91 98802 22741" />
            </label>
          </div>
          <div className={styles.options}>
            <label>
              <input
                type="checkbox"
                checked={meet}
                onChange={(e) => setMeet(e.target.checked)}
              />
              <span>
                <b>
                  {mode === "boarding"
                    ? "3-hour host-home trial · Included"
                    : "2-hour sitter Meet & Greet · ₹500"}
                </b>
                <small>
                  {mode === "boarding"
                    ? "Visit the host home with your pet before the stay"
                    : "The sitter visits your home to learn routines and access"}
                </small>
              </span>
            </label>
            {meet && (
              <div className={styles.meetFormats}>
                <button className={meetFormat === "call" ? styles.selected : ""} onClick={() => setMeetFormat("call")}>
                  <b>10-minute phone call · Included</b>
                  <small>Speak with the {mode === "boarding" ? "host" : "sitter"}, understand routines and ask questions before booking.</small>
                </button>
                <button className={meetFormat === "visit" ? styles.selected : ""} onClick={() => setMeetFormat("visit")}>
                  <b>{mode === "boarding" ? "3-hour host-home trial · Included" : "2-hour home Meet & Greet · ₹500"}</b>
                  <small>{mode === "boarding" ? "Visit the home with your pet and check comfort before the stay." : "Meet the sitter at home, explain access and walk through the care routine."}</small>
                </button>
              </div>
            )}
            {mode === "boarding" && (
              <label>
                <input
                  type="checkbox"
                  checked={taxi}
                  onChange={(e) => setTaxi(e.target.checked)}
                />
                <span>
                  <b>Add Pet Taxi · ₹499</b>
                  <small>
                    Tracked pickup and drop · three-hour arrival window
                  </small>
                </span>
              </label>
            )}
            <label>
              <input type="checkbox" defaultChecked />
              <span>
                <b>Care Card updates</b>
                <small>Meals, walks, medication, photos and check-in/out</small>
              </span>
            </label>
          </div>
          <button className={styles.back} onClick={() => setStage(2)}>
            ← Caregiver
          </button>
          <button className={styles.primary} onClick={() => setStage(4)}>
            Review protected booking
          </button>
        </>
      )}
      {stage === 4 && (
        <>
          <Head title="Review and confirm" note="OTP · 4 of 4" />
          <article className={styles.review}>
            <span>
              Service
              <b>
                {mode === "boarding"
                  ? "Home Boarding"
                  : "Overnight Pet Sitting"}
              </b>
            </span>
            <span>
              Pets<b>{selectedPets.join(" + ")}</b>
            </span>
            <span>
              Dates
              <b>
                {careWindow === "24 hours"
                  ? `${shortDate(start)}–${shortDate(end)} · ${nights} nights`
                  : `${shortDate(start)} · ${careWindow}`}
              </b>
            </span>
            <span>
              Caregiver
              <b>
                {caregiver.name} · {caregiver.rating} ★ · commission partner
              </b>
            </span>
            <span>
              Partner approval<b>Accepted offer · final calendar approval required</b>
            </span>
            <span>
              Care benefits<b>{selectedBenefits.join(" · ")}</b>
            </span>
            <span>
              Food<b>{foodType}</b>
            </span>
            <span>
              {mode === "boarding" ? "Host-home trial" : "Meet & Greet"}
              <b>
                {meet
                  ? meetFormat === "call"
                    ? "10-minute phone call · Included"
                    : mode === "boarding"
                      ? "3 hours · Included"
                      : `2 hours · ${money(meetFee)}`
                  : "Skipped"}
              </b>
            </span>
            <span>
              Primary + secondary<b>Booking and emergency updates enabled</b>
            </span>
          </article>
          <div className={styles.bill}>
            <span>
              {caregiver.name} · {careWindow === "24 hours" ? `${nights} nights` : careWindow}<b>{money(base)}</b>
            </span>
            {extraPets > 0 && (
              <span>
                {extraPets} additional {extraPets === 1 ? "pet" : "pets"}
                <b>{money(extra)}</b>
              </span>
            )}
            <span>
              PawSpace protection & 24/7 support<b>{money(protection)}</b>
            </span>
            {taxi && mode === "boarding" && (
              <span>
                Tracked Pet Taxi<b>{money(taxiFee)}</b>
              </span>
            )}
            {meet && (
              <span>
                {meetFormat === "call"
                  ? "10-minute confidence call"
                  : mode === "boarding"
                    ? "3-hour host-home trial"
                    : "2-hour sitter Meet & Greet"}
                <b>{meetFormat === "call" || mode === "boarding" ? "Included" : money(meetFee)}</b>
              </span>
            )}
            <strong>
              Booking total<b>{money(total)}</b>
            </strong>
          </div>
          {splitEligible ? (
            <section className={styles.paymentChoice}>
              <header>
                <div>
                  <span>LONG-STAY PAYMENT</span>
                  <b>{nights} nights qualifies for partial payment</b>
                </div>
                <em>MORE THAN 5 NIGHTS</em>
              </header>
              <button
                className={splitPayment ? styles.selected : ""}
                onClick={() => setSplitPayment(true)}
              >
                <i>{splitPayment ? "✓" : ""}</i>
                <span>
                  <b>Reserve with 50% now</b>
                  <small>
                    {money(reserveAmount)} now · {money(balanceAmount)} due 24
                    hours before check-in
                  </small>
                </span>
              </button>
              <button
                className={!splitPayment ? styles.selected : ""}
                onClick={() => setSplitPayment(false)}
              >
                <i>{!splitPayment ? "✓" : ""}</i>
                <span>
                  <b>Pay the full amount now</b>
                  <small>{money(total)} · no later balance</small>
                </span>
              </button>
              {meet && mode === "sitting" && meetFormat === "visit" && (
                <p>
                  The ₹500 meeting fee is collected now; only the stay value is
                  split 50/50.
                </p>
              )}
            </section>
          ) : (
            <article className={styles.fullPaymentNote}>
              <i>₹</i>
              <div>
                <b>Full payment for hourly care and stays up to 5 nights</b>
                <span>
                  Partial payment becomes available automatically for bookings
                  longer than five nights.
                </span>
              </div>
            </article>
          )}
          <CouponField
            service={mode === "boarding" ? "Boarding" : "Pet Sitting"}
            orderValue={totalBeforeCoupon}
            customerKind="existing"
            paymentMode={splitEligible && splitPayment ? "partial" : "full"}
            onDiscountChange={(value, code) => {
              setDiscount(value);
              setCouponCode(code);
            }}
          />
          {discount > 0 && (
            <article className={styles.couponSaving}>Coupon saving <b>−{money(discount)}</b></article>
          )}
          <article className={styles.protection}>
            <i>✓</i>
            <div>
              <b>PawSpace Stay Protection</b>
              <span>
                Calendar and capacity verified, secure payment, caregiver
                replacement, cancellation/refund workflow and 24/7 incident
                support.
              </span>
            </div>
          </article>
          <label className={styles.consent}>
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
            />{" "}
            I agree to care, home-access, cancellation, media and emergency
            terms.
          </label>
          <p className={styles.hint}>
            OTP is requested only now. {money(reserveAmount)} will be collected
            in this test checkout. {balanceAmount > 0
              ? `${money(balanceAmount)} is due 24 hours before the booking starts.`
              : "No later balance remains."}
          </p>
          <button className={styles.back} onClick={() => setStage(3)}>
            ← Care plan
          </button>
          <button
            disabled={!agreed || !datesValid || scheduling}
            className={styles.primary}
            onClick={confirm}
          >
            {scheduling ? "Locking care capacity…" : `Pay ${money(reserveAmount)} & request final partner approval`}
          </button>
          {scheduleError && <p role="alert">{scheduleError}</p>}
        </>
      )}
    </section>
  );
}

function CaregiverProfile({
  mode,
  caregiver,
  start,
  end,
}: {
  mode: Mode;
  caregiver: Caregiver;
  start: string;
  end: string;
}) {
  const boarding = mode === "boarding";
  const gallery = boarding
    ? [
        ["/assets/stays/maya-rohan-profile.webp", "Host & guest pet"],
        ["/assets/stays/indiranagar-home.webp", "Living room & terrace"],
        ["/assets/stays/pet-guest-room.webp", "Guest pet room"],
      ]
    : [
        ["/assets/stays/sitter-profile.webp", "Sitter profile"],
        ["/assets/stays/sitter-care-update.webp", "Recent care update"],
      ];
  const amenities = boarding
    ? [
        ...caregiver.features,
        "Fenced terrace",
        "Pet-only sleeping area",
        "Power backup",
        "Vet within 2 km",
      ]
    : [
        ...caregiver.features,
        "Overnight stay",
        "Secure key handover",
        "Meal & medication log",
        "Emergency transport",
      ];
  return (
    <article className={styles.fullProfile}>
      <header className={styles.profileHeader}>
        <div>
          <span>TEST PARTNER PROFILE</span>
          <h3>{caregiver.name}</h3>
          <p>
            📍 {caregiver.area} · {caregiver.response}
          </p>
        </div>
        <b>{caregiver.rating} ★</b>
      </header>
      <div
        className={[
          styles.profileGallery,
          !boarding ? styles.sitterGallery : "",
        ].join(" ")}
      >
        {gallery.map(([src, label], index) => (
          <figure key={src} className={index === 0 ? styles.galleryLead : ""}>
            <img src={src} alt={label} />
            <figcaption>{label}</figcaption>
          </figure>
        ))}
      </div>
      <div className={styles.trustStats}>
        <span>
          <b>{caregiver.reviews}</b>verified reviews
        </span>
        <span>
          <b>{caregiver.repeat}</b>repeat families
        </span>
        <span>
          <b>{caregiver.match}</b>pet match
        </span>
        <span>
          <b>{boarding ? "98%" : "99%"}</b>Care Card completion
        </span>
      </div>
      <section className={styles.aboutProfile}>
        <span>ABOUT {caregiver.name.toUpperCase()}</span>
        <h4>{caregiver.home}</h4>
        <p>
          {boarding
            ? "We keep guest numbers low, follow every pet's home routine and share morning and evening updates. A Meet & Greet is encouraged before the first stay."
            : "I care for pets in their familiar home, follow approved access instructions and record meals, walks, medication and photos in the live Care Card."}
        </p>
      </section>
      <section className={styles.amenities}>
        <div className={styles.profileSectionHead}>
          <b>{boarding ? "Home & amenities" : "Services & support"}</b>
          <span>Partner-verified</span>
        </div>
        <div>
          {amenities.map((item) => (
            <span key={item}>✓ {item}</span>
          ))}
        </div>
      </section>
      <section className={styles.profileCalendar}>
        <div className={styles.profileSectionHead}>
          <b>Live availability</b>
          <span>
            {shortDate(start)}–{shortDate(end)} held
          </span>
        </div>
        <div>
          {[
            ["24", "Available"],
            ["25", "Available"],
            ["26", "1 spot"],
            ["27", "1 spot"],
            ["28", "Full"],
            ["29", "Available"],
            ["30", "Blocked"],
          ].map(([day, status]) => (
            <span
              key={day}
              className={
                status === "Full" || status === "Blocked"
                  ? styles.unavailable
                  : ""
              }
            >
              <b>{day}</b>
              <small>{status}</small>
            </span>
          ))}
        </div>
        <small>
          Capacity changes in the {boarding ? "Host" : "Sitter"} Partner App
          immediately update customer search.
        </small>
      </section>
      <section className={styles.profileRules}>
        <div>
          <b>{boarding ? "Home rules" : "Service boundaries"}</b>
          <span>
            {boarding
              ? "Vaccinated pets · Meet & Greet for first stay · no unapproved off-leash time"
              : "Approved tasks only · no guest access · keys returned at checkout"}
          </span>
        </div>
        <div>
          <b>Cancellation</b>
          <span>
            Full policy shown before payment · replacement support included
          </span>
        </div>
      </section>
      <section className={styles.reviewBlock}>
        <div className={styles.profileSectionHead}>
          <b>What pet parents say</b>
          <span>View all {caregiver.reviews}</span>
        </div>
        <article>
          <span>5.0 ★ · VERIFIED STAY</span>
          <p>
            “Bruno settled quickly and every meal, walk and medication update
            arrived on time. The photos made us feel completely at ease.”
          </p>
          <b>— Ananya · repeat parent</b>
        </article>
        <article>
          <span>4.9 ★ · VERIFIED BOOKING</span>
          <p>
            “Clear communication, a thoughtful Meet & Greet and excellent care
            for both our dog and cat.”
          </p>
          <b>— Vikram · 3 bookings</b>
        </article>
      </section>
      <footer className={styles.verifiedBar}>
        <div>
          <b>✓ Identity</b>
          <b>✓ Background</b>
          <b>{boarding ? "✓ Home inspection" : "✓ Address verification"}</b>
          <b>✓ Pet first aid</b>
        </div>
        <span>
          PawSpace verification and quality monitoring · test profile
        </span>
      </footer>
    </article>
  );
}

function Head({ title, note }: { title: string; note: string }) {
  return (
    <div className={styles.head}>
      <h3>{title}</h3>
      <small>{note}</small>
    </div>
  );
}
function LiveStay({
  bookingId,
  start,
  end,
  nights,
  mode,
  caregiver,
  pets,
  total,
  taxi,
  view,
  setView,
}: {
  bookingId: string;
  start: string;
  end: string;
  nights: number;
  mode: Mode;
  caregiver: Caregiver;
  pets: string[];
  total: number;
  taxi: boolean;
  view: View;
  setView: (v: View) => void;
}) {
  return (
    <section className={styles.flow}>
      <article className={styles.success}>
        <i>✓</i>
        <div>
          <small>
            {mode === "boarding" ? "STAY" : "SITTING"} CONFIRMED · {bookingId}
          </small>
          <h3>{pets.join(" + ")} are all set.</h3>
          <p>
            {shortDate(start)}–{shortDate(end)} · {nights} nights ·{" "}
            {caregiver.name} · {money(total)}
          </p>
        </div>
      </article>
      <div className={styles.status}>
        <span className={styles.done}>Confirmed</span>
        <i />
        <span className={styles.done}>
          {taxi && mode === "boarding" ? "Taxi assigned" : "Care shared"}
        </span>
        <i />
        <span>Check-in</span>
        <i />
        <span>Complete</span>
      </div>
      {mode === "sitting" && (
        <ProviderTrackingCard role="Sitter" name={caregiver.name} eta="16 min" />
      )}
      {taxi && mode === "boarding" && (
        <article className={styles.taxi}>
          <i>↗</i>
          <div>
            <b>Pet Taxi assigned · KA 03 EV 4821</b>
            <span>
              Pickup window 7:00–10:00 AM · live tracking starts on arrival
            </span>
          </div>
          <button>Track</button>
        </article>
      )}
      <div className={styles.tabs}>
        <button
          className={view === "stay" ? styles.selected : ""}
          onClick={() => setView("stay")}
        >
          Booking
        </button>
        <button
          className={view === "care" ? styles.selected : ""}
          onClick={() => setView("care")}
        >
          Care Card
        </button>
        <button
          className={view === "support" ? styles.selected : ""}
          onClick={() => setView("support")}
        >
          Safety
        </button>
      </div>
      {view === "stay" && (
        <>
          <article className={styles.next}>
            <span>NEXT STEP</span>
            <h4>Meet & Greet · 20 Aug, 6:00 PM</h4>
            <p>
              {caregiver.name} · both sides receive 24-hour and 2-hour
              reminders.
            </p>
            <div>
              <button>Reschedule</button>
              <button>Secure chat</button>
            </div>
          </article>
          <article className={styles.person}>
            <i>{caregiver.initials}</i>
            <div>
              <span>{caregiver.badge}</span>
              <b>
                {caregiver.name} · {caregiver.rating} ★
              </b>
              <small>{caregiver.area} · identity and background verified</small>
            </div>
            <button>Profile</button>
          </article>
          <article className={styles.rules}>
            <b>Change of plans?</b>
            <span>
              Reschedule from the caregiver’s live calendar. A caregiver
              cancellation triggers replacement matching; customer cancellation
              and refunds follow the displayed policy.
            </span>
          </article>
        </>
      )}
      {view === "care" && (
        <>
          <article className={styles.careLive}>
            <span>● LIVE CARE CARD · DAY 2 OF 4</span>
            <h4>Everything is on routine</h4>
            <p>
              Updates reach the primary and secondary contacts automatically.
            </p>
          </article>
          <div className={styles.events}>
            {[
              [
                "✓",
                "Breakfast finished",
                "7:42 AM · full portion · water refreshed",
              ],
              ["✓", "Morning walk", "8:25 AM · 32 min · toilet logged"],
              [
                "▶",
                "Happy video · 00:18",
                "10:10 AM · relaxing after playtime",
              ],
              ["✓", "Medication given", "12:30 PM · photo proof added"],
              ["○", "Evening update", "Due by 7:00 PM"],
            ].map((e) => (
              <article key={e[1]}>
                <i>{e[0]}</i>
                <div>
                  <b>{e[1]}</b>
                  <span>{e[2]}</span>
                </div>
              </article>
            ))}
          </div>
          <button className={styles.primary}>
            Message {caregiver.name.split(" ")[0]}
          </button>
        </>
      )}
      {view === "support" && (
        <>
          <article className={styles.safety}>
            <i>♢</i>
            <div>
              <span>24/7 PAWSPACE CARE DESK</span>
              <h4>Your booking is protected.</h4>
              <p>
                Location-aware check-in, missed-update alerts, incident tickets
                and replacement care connect customer, caregiver and the
                PawSpace team.
              </p>
            </div>
          </article>
          <div className={styles.safetyActions}>
            <button>
              ⚕ Pet health concern<small>Connect Care Desk</small>
            </button>
            <button>
              ! Cannot reach caregiver<small>Open priority ticket</small>
            </button>
            <button>
              ↻ Need early pickup<small>Coordinate safely</small>
            </button>
            <button>
              ₹ Payment or refund<small>Track resolution</small>
            </button>
          </div>
          <article className={styles.audit}>
            <b>Protected activity log</b>
            <span>✓ Care plan accepted · 18 Aug, 6:42 PM</span>
            <span>✓ Meet & Greet scheduled · 18 Aug, 6:44 PM</span>
            <span>✓ Payment protected · 18 Aug, 6:45 PM</span>
            <span>✓ Primary + secondary contacts notified</span>
          </article>
        </>
      )}
    </section>
  );
}
