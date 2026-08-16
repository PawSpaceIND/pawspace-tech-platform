"use client";
/* eslint-disable @next/next/no-img-element */
import { useEffect, useState } from "react";
import styles from "./stay-flow.module.css";
import { createTestTransaction } from "../../lib/test-transaction";
import ProviderTrackingCard from "./provider-tracking-card";
import CouponField from "./coupon-field";
import PetManager from "./pet-manager";
import { loadCustomerPets, type CustomerPet } from "../../lib/customer-account-client";
import { reserveUatSchedule } from "../../lib/uat-scheduling-client";
import { createCanonicalLifecycle } from "../../lib/canonical-lifecycle-client";
import { loadBoardingCommercial, quoteBoarding, type BoardingHost, type BoardingQuote } from "../../lib/boarding-commercial-client";
import BoardingCustomerStayPanel from "./boarding-customer-stay-panel";
import BoardingCustomerStayStatus from "./boarding-customer-stay-status";

type Mode = "boarding" | "sitting";
type View = "stay" | "care" | "support";
type CareWindow = "4 hours" | "10 hours" | "12 hours" | "24 hours";
type Caregiver = {
  providerId?: string;
  model?: "full_time" | "commission";
  name: string;
  initials: string;
  area: string;
  rating: string;
  reviews?: number;
  repeat?: number;
  price: number;
  match?: string;
  badge: string;
  response?: string;
  home: string;
  features: string[];
  capacity: string;
  availabilityVerified?: boolean;
  availableGuestPets?: number;
};
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
const petIcon = (species: string) => (species === "cat" ? "🐈" : species === "dog" ? "🐕" : "🐾");
const petDetail = (pet: CustomerPet) =>
  [pet.profile?.breed || pet.breed, pet.profile?.ageBand, pet.profile?.weightBand].filter(Boolean).join(" · ") ||
  "Profiles, health notes and service history included";
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
const dateOffset = (days: number) => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
};
const boardingPlaceholder: Caregiver = {
  providerId: "",
  name: "Select a verified host",
  initials: "VH",
  area: "Bengaluru East",
  rating: "—",
  price: 0,
  badge: "Governed Boarding",
  home: "Host availability is loaded from PawSpace capacity records for the selected stay window.",
  features: [],
  capacity: "Window availability required",
};
const hostInitials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join("") || "BH";
const toBoardingCaregiver = (host: BoardingHost): Caregiver => ({
  providerId: host.providerId,
  model: host.model,
  name: host.name,
  initials: hostInitials(host.name),
  area: host.area,
  rating: host.rating.toFixed(1),
  price: 0,
  badge: "Verified Boarding host",
  response: "Selected-window capacity checked",
  home: `Verified host home · resident pets: ${host.residentPets || "none"}`,
  features: [
    `Species: ${host.species.join(", ")}`,
    host.medicationSupport ? "Medication support enabled" : "Medication support not enabled",
    host.oneFamilyOnly ? "One family at a time" : "Multiple families allowed by profile",
    "Home, KYC and background verified",
  ],
  capacity: `${host.availableGuestPets ?? host.capacity} of ${host.capacity} guest-pet spots available`,
  availabilityVerified: Boolean(host.availabilityVerified),
  availableGuestPets: host.availableGuestPets ?? host.capacity,
});

import type { LoggedInCustomer } from "./customer-login";
export default function StayFlow({ mode: initialMode, customer }: { mode: Mode; customer: LoggedInCustomer }) {
  const [mode, setMode] = useState<Mode>(initialMode),
    [stage, setStage] = useState(1),
    [selectedPets, setSelectedPets] = useState<string[]>([]),
    [pets, setPets] = useState<CustomerPet[]>([]),
    [petsLoading, setPetsLoading] = useState(true),
    [petsError, setPetsError] = useState(""),
    [showPetManager, setShowPetManager] = useState(false),
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
    [caregiver, setCaregiver] = useState<Caregiver>(
      initialMode === "boarding" ? boardingPlaceholder : sitters[0],
    ),
    [boardingHosts, setBoardingHosts] = useState<Caregiver[]>([]),
    [boardingHostWindowKey, setBoardingHostWindowKey] = useState(""),
    [boardingHostError, setBoardingHostError] = useState(""),
    [meet, setMeet] = useState(true),
    [meetFormat, setMeetFormat] = useState<"visit" | "call">("visit"),
    [taxi, setTaxi] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [agreed, setAgreed] = useState(true),
    [start, setStart] = useState(() => dateOffset(3)),
    [end, setEnd] = useState(() => dateOffset(10)),
    [bookingId, setBookingId] = useState(""),
    [scheduling, setScheduling] = useState(false),
    [scheduleError, setScheduleError] = useState(""),
    [profileOpen, setProfileOpen] = useState(true),
    [splitPayment, setSplitPayment] = useState(true),
    [discount, setDiscount] = useState(0),
    [couponCode, setCouponCode] = useState(""),
    [boardingQuote, setBoardingQuote] = useState<BoardingQuote | null>(null),
    [chatOpen, setChatOpen] = useState(false),
    [view, setView] = useState<View>("stay"),
    [toast, setToast] = useState("");
  const flash = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  };
  // The stay is for the customer's OWN pets. Load them and make selection (by canonical pet id) the
  // single source of truth for species, count, host matching and the pet ids sent to the reserve/booking.
  useEffect(() => {
    let active = true;
    setPetsLoading(true);
    loadCustomerPets(customer.customerId)
      .then((loaded) => {
        if (!active) return;
        setPets(loaded);
        setSelectedPets((prev) => {
          const kept = prev.filter((id) => loaded.some((p) => p.id === id));
          return kept.length ? kept : loaded[0] ? [loaded[0].id] : [];
        });
        setPetsError("");
      })
      .catch((e) => { if (active) setPetsError(e instanceof Error ? e.message : "Unable to load your pets"); })
      .finally(() => { if (active) setPetsLoading(false); });
    return () => { active = false; };
  }, [customer.customerId]);
  const onPetsChanged = (updated: CustomerPet[]) => {
    setPets(updated);
    setSelectedPets((prev) => {
      const kept = prev.filter((id) => updated.some((p) => p.id === id));
      return kept.length ? kept : updated[0] ? [updated[0].id] : [];
    });
  };
  const selectedPetObjs = pets.filter((p) => selectedPets.includes(p.id));
  const selectedPetNames = selectedPetObjs.map((p) => p.name);
  const selectedSpecies = [...new Set(selectedPetObjs.map((p) => p.species).filter((value): value is string => Boolean(value)))];
  const boardingHostQueryKey = `${start}|${end}|${careWindow}|${selectedPets.slice().sort().join(",")}`;
  const caregivers = mode === "boarding" ? (boardingHostWindowKey === boardingHostQueryKey ? boardingHosts : []) : sitters;
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
  const boardingUnitPrice=boardingQuote?.basePricePerPet??0,boardingUnits=boardingQuote?.stayUnits??0;
  const base = mode === "boarding" ? boardingUnitPrice*boardingUnits : Math.round(caregiver.price * durationMultiplier);
  const extra = mode === "boarding" ? extraPets*boardingUnitPrice*boardingUnits : Math.round(extraPets * 399 * durationMultiplier);
  const protection = mode === "boarding" ? 0 : 249;
  const taxiFee = 0;
  const stayTotal = base + extra + protection + taxiFee;
  const meetFee = meet && mode === "sitting" && meetFormat === "visit" ? 500 : 0;
  const totalBeforeCoupon = stayTotal + meetFee;
  const total = mode === "boarding" ? boardingQuote?.totalAmount??0 : Math.max(0, totalBeforeCoupon - discount);
  const splitEligible = careWindow === "24 hours" && nights > 4;
  const discountedStay = Math.max(0, stayTotal - discount);
  const reserveAmount = mode === "boarding" ? boardingQuote?.amountDueNow??0 : splitEligible && splitPayment
    ? Math.ceil(discountedStay / 2) + meetFee
    : total;
  const balanceAmount = mode === "boarding"
    ? Math.max(0, (boardingQuote?.totalAmount??0) - (boardingQuote?.amountDueNow??0))
    : splitEligible && splitPayment
    ? discountedStay - Math.ceil(discountedStay / 2)
    : 0;
  useEffect(()=>{if(mode!=="boarding"||selectedPets.length===0)return;let active=true;const scheduleStart=new Date(`${start}T03:30:00.000Z`),scheduleEnd=careWindow==="24 hours"?new Date(`${end}T03:30:00.000Z`):new Date(scheduleStart.getTime()+(careWindow==="10 hours"?10:4)*3_600_000),packageCode=careWindow==="4 hours"?"boarding-4h":careWindow==="10 hours"?"boarding-10h":"boarding-24h";void quoteBoarding({packageCode,petCount:selectedPets.length,scheduledStart:scheduleStart.toISOString(),scheduledEnd:scheduleEnd.toISOString(),paymentMode:splitEligible&&splitPayment?"split_50_50":"prepaid"}).then(value=>{if(active){setBoardingQuote(value);setScheduleError("");}}).catch(problem=>{if(active){setBoardingQuote(null);setScheduleError(problem instanceof Error?problem.message:"Unable to refresh Boarding quote");}});return()=>{active=false;};},[mode,careWindow,start,end,selectedPets.length,splitEligible,splitPayment]);
  useEffect(()=>{if(mode!=="boarding"||selectedPets.length===0)return;let active=true;const queryKey=boardingHostQueryKey,scheduleStart=new Date(`${start}T03:30:00.000Z`),scheduleEnd=careWindow==="24 hours"?new Date(`${end}T03:30:00.000Z`):new Date(scheduleStart.getTime()+(careWindow==="10 hours"?10:4)*3_600_000);void loadBoardingCommercial({cityId:"blr",zoneId:"blr-east",scheduledStart:scheduleStart.toISOString(),scheduledEnd:scheduleEnd.toISOString(),petCount:selectedPets.length,species:selectedSpecies}).then(data=>{if(!active)return;const hosts=data.hosts.map(toBoardingCaregiver);setBoardingHosts(hosts);setBoardingHostWindowKey(queryKey);setBoardingHostError("");setCaregiver(current=>hosts.find(host=>host.providerId===current.providerId)??hosts[0]??boardingPlaceholder);}).catch(problem=>{if(!active)return;setBoardingHosts([]);setBoardingHostWindowKey(queryKey);setBoardingHostError(problem instanceof Error?problem.message:"Unable to load Boarding host availability");setCaregiver(boardingPlaceholder);});return()=>{active=false;};},[mode,careWindow,start,end,selectedPets.length,boardingHostQueryKey,selectedSpecies.join(",")]);
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
    setCaregiver(next === "boarding" ? boardingPlaceholder : sitters[0]);
    if(next==="boarding"&&careWindow==="12 hours")setCareWindow("10 hours");
    if(next==="sitting"&&careWindow==="10 hours")setCareWindow("12 hours");
    setTaxi(false);
    setProfileOpen(true);
  };
  const confirm = async () => {
    if (!datesValid || !agreed) return;
    setScheduling(true);setScheduleError("");
    try {
    const scheduleStart=new Date(`${start}T03:30:00.000Z`);const scheduleEnd=careWindow==="24 hours"?new Date(`${end}T03:30:00.000Z`):new Date(scheduleStart.getTime()+(careWindow==="10 hours"?10:careWindow==="12 hours"?12:4)*3_600_000);const providerIds:Record<string,string>={"Sana F.":"sit_sana","Neha P.":"sit_neha"};const boardingCommercial=mode==="boarding"?await loadBoardingCommercial({cityId:"blr",zoneId:"blr-east",scheduledStart:scheduleStart.toISOString(),scheduledEnd:scheduleEnd.toISOString(),petCount:selectedPets.length,species:selectedSpecies}):null,governedHost=boardingCommercial?.hosts.find(item=>item.providerId===caregiver.providerId);if(mode==="boarding"&&!governedHost)throw new Error("Selected Boarding host is no longer available for this stay window");const packageCode=careWindow==="4 hours"?"boarding-4h":careWindow==="10 hours"?"boarding-10h":"boarding-24h",governedBoardingQuote=mode==="boarding"?await quoteBoarding({packageCode,petCount:selectedPets.length,scheduledStart:scheduleStart.toISOString(),scheduledEnd:scheduleEnd.toISOString(),paymentMode:splitEligible&&splitPayment?"split_50_50":"prepaid"}):null;const requestId=`${mode}-${customer.customerId}-${start}-${end}-${careWindow.replaceAll(" ","")}-${selectedPets.length}-${Date.now()}`;const decision=await reserveUatSchedule({clientRequestId:requestId,customerId:customer.customerId,petIds:selectedPets,serviceCode:mode==="boarding"?"boarding":"pet_sitting",zoneId:"blr-east",scheduledStart:scheduleStart.toISOString(),scheduledEnd:scheduleEnd.toISOString(),careMode:careWindow==="24 hours"?"overnight":"visit",preferredProviderId:mode==="boarding"?governedHost?.providerId:providerIds[caregiver.name]});
    const canonical=await createCanonicalLifecycle({idempotencyKey:requestId,scheduleGroupId:decision.groupId,customer:{id:customer.customerId,name:customer.customerName,primaryPhone:customer.phone},pets:selectedPetObjs.map(p=>({sourceId:p.sourceId??p.id,name:p.name,species:p.species==="cat"?"cat":p.species==="dog"?"dog":"other" as const,vaccinationStatus:mode==="boarding"?"verified":"not_provided"})),cityId:"blr",zoneId:"blr-east",serviceCode:mode==="boarding"?"boarding":"pet_sitting",packageCode:governedBoardingQuote?.packageCode??(careWindow==="24 hours"?"overnight-sitting":"home-visit"),packageName:governedBoardingQuote?.packageName??"Pet Sitting",scheduledStart:scheduleStart.toISOString(),scheduledEnd:scheduleEnd.toISOString(),provider:decision.provider,totalAmount:governedBoardingQuote?.totalAmount??total,amountDueNow:governedBoardingQuote?.amountDueNow??reserveAmount,payment:{method:"upi",mode:splitEligible&&splitPayment?"split_50_50":"prepaid",status:"captured",detail:mode==="boarding"?(splitEligible&&splitPayment?"UAT 50% Boarding deposit captured from server quote; balance due 24h before check-in":"UAT Boarding payment captured from server quote"):splitEligible&&splitPayment?"UAT 50% stay deposit captured; balance due 24h before the stay starts":"UAT payment captured"},pricing:{discount:mode==="boarding"?0:discount,couponCode:mode==="boarding"?undefined:couponCode||undefined,boardingQuoteId:governedBoardingQuote?.quoteId}});
    const booking = createTestTransaction({
      customerId: customer.customerId,
      customerName: customer.customerName,
      primary: customer.phone,
      secondary: "",
      pets: selectedPetNames.join(", "),
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
      amount: governedBoardingQuote?.totalAmount ?? total,
      offerCode: mode === "boarding" ? undefined : couponCode || undefined,
      discount: mode === "boarding" ? 0 : discount,
      payment:
        mode === "boarding"
          ? splitEligible && splitPayment
            ? `50% deposit paid in UAT sandbox from canonical Boarding quote · ${money(balanceAmount)} due 24 hours before check-in`
            : "Paid in UAT sandbox from canonical Boarding quote"
          : splitEligible && splitPayment
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
      <>
        {toast && <div className={styles.toast}>{toast}</div>}
        <LiveStay
          bookingId={bookingId}
          start={start}
          end={end}
          nights={nights}
          mode={mode}
          caregiver={caregiver}
          pets={selectedPetNames}
          total={total}
          taxi={taxi}
          view={view}
          setView={setView}
          flash={flash}
        />
      </>
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
            {(mode === "boarding" ? (["4 hours", "10 hours", "24 hours"] as CareWindow[]) : (["4 hours", "12 hours", "24 hours"] as CareWindow[])).map((window) => (
              <button
                key={window}
                className={careWindow === window ? styles.selected : ""}
                onClick={() => setCareWindow(window)}
              >
                <b>{window}</b>
                <small>
                  {window === "4 hours"
                    ? "Short care"
                    : window === "10 hours" || window === "12 hours"
                      ? "Day care"
                      : "Overnight / multi-day"}
                </small>
              </button>
            ))}
          </div>
          <label className={styles.field}>
            Service zone
            <select value="Bengaluru East · UAT" disabled>
              <option>Bengaluru East · UAT</option>
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
            {petsLoading && <p className={styles.hint}>Loading your pets…</p>}
            {petsError && <p className={styles.hint} role="alert">{petsError}</p>}
            {!petsLoading && !petsError && pets.length === 0 && (
              <p className={styles.hint}>No pets on your profile yet — add one below, then select it to book.</p>
            )}
            {pets.map((p) => (
              <button
                key={p.id}
                className={selectedPets.includes(p.id) ? styles.selected : ""}
                onClick={() => togglePet(p.id)}
              >
                <i>{petIcon(p.species)}</i>
                <span>
                  <b>{p.name}</b>
                  <small>{petDetail(p)}</small>
                </span>
                <em>{selectedPets.includes(p.id) ? "✓" : "＋"}</em>
              </button>
            ))}
            <button className={styles.addPet} onClick={() => setShowPetManager(v => !v)}>
              <i>{showPetManager ? "−" : "＋"}</i>
              <span>
                <b>{showPetManager ? "Hide pet details" : "Add another pet"}</b>
                <small>Add or edit right here — no need to leave the booking</small>
              </span>
            </button>
          </div>
          {showPetManager && <PetManager customer={customer} onPetsChanged={onPetsChanged}/>}
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
              ? mode === "boarding"
                ? `${careWindow === "24 hours" ? `${nights} nights` : careWindow} selected · PawSpace will check verified host species, leave blocks and stay capacity for this exact window.`
                : `${careWindow === "24 hours" ? `${nights} nights` : careWindow} selected · request goes to eligible commission partners within 15 km.`
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
          {mode === "boarding" ? (
            <article className={styles.matchIntro}>
              <i>✦</i>
              <div>
                <b>Server-priced verified Boarding hosts</b>
                <span>Host profiles can be selected here, but PawSpace rechecks verification, species eligibility and capacity at confirmation. Hosts cannot send a different Boarding price.</span>
              </div>
            </article>
          ) : <>
            <article className={styles.matchIntro}>
              <i>✦</i>
              <div>
                <b>Request shared within a 15 km service radius</b>
                <span>Verified commission partners receive the request, review the Care Card and send an acceptance or flexible offer.</span>
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
          </>}
          {mode === "boarding" && boardingHostWindowKey !== boardingHostQueryKey && <p className={styles.hint}>Checking governed host availability for this stay window…</p>}
          {mode === "boarding" && boardingHostWindowKey === boardingHostQueryKey && caregivers.length === 0 && <p role="alert" className={styles.hint}>{boardingHostError || "No verified Boarding host currently has capacity for every selected pet in this UAT window."}</p>}
          <div className={styles.caregivers}>
            {caregivers.map((c, i) => (
              <button
                key={c.providerId ?? c.name}
                className={caregiver.name === c.name ? styles.selected : ""}
                onClick={() => {
                  setCaregiver(c);
                  setProfileOpen(true);
                }}
              >
                <div className={styles.caregiverTop}>
                  {mode === "sitting" && i === 0 ? (
                    <img src="/assets/stays/sitter-profile.webp" alt={c.name + " test profile"} />
                  ) : (
                    <i>{c.initials}</i>
                  )}
                  <div>
                    <span>{c.badge}</span>
                    <h4>{c.name}</h4>
                  <small>
                    {mode === "boarding" ? `📍 ${c.area} · selected-window capacity checked` : `📍 ${c.area} · ${(i + 1) * 3.2} km · ${c.response}`}
                  </small>
                  </div>
                  {mode === "sitting" && <em>
                    {c.match}
                    <small>match</small>
                  </em>}
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
                    {mode === "boarding" ? `${c.availableGuestPets ?? 0} guest-pet spots available` : `${c.reviews} reviews · ${c.repeat} repeats`}
                  </span>
                  <strong>
                    {money(mode === "boarding" ? (boardingQuote?.basePricePerPet ?? 0) : c.price)}
                    <small>{mode === "boarding" ? " / pet / stay unit" : " / night"}</small>
                  </strong>
                </div>
                {mode === "boarding" ? (
                  <label>✓ Governed host · selected-window availability verified in UAT</label>
                ) : <>
                  {i < 2 && <label>✓ Partner accepted · live calendar verified</label>}
                  {i === 2 && <label>Flexible offer · awaiting your response</label>}
                </>}
              </button>
            ))}
          </div>
          <article className={styles.profileNote}>
            <div>
              <b>
                {caregiver.name} · {caregiver.capacity}
              </b>
              <span>
                {mode === "boarding" ? "Identity, species eligibility and stay capacity come from PawSpace governed records. Host media and customer reviews are not connected in Boarding UAT." : "Photos, reviews, amenities, calendar and care rules are managed from the Sitter Partner App."}
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
            mode === "boarding" ? <article className={styles.secureChat}><header><b>Boarding chat</b><span>UAT boundary</span></header><p>Live masked chat is not connected yet. This screen does not simulate host messages.</p></article> : <article className={styles.secureChat}>
              <header><b>Chat with {caregiver.name}</b><span>Numbers stay masked</span></header>
              <p><b>{caregiver.name.split(" ")[0]}:</b> I can support medication, three walks and the one-hour play routine.</p>
              <p><b>You:</b> Can you also arrange pickup and share a flexible all-inclusive price?</p>
              <label><input placeholder="Type a message" /><button onClick={() => flash("Live masked chat is not connected yet in UAT.")}>Send</button></label>
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
          <button className={styles.primary} disabled={mode === "boarding" && !caregiver.providerId} onClick={() => setStage(3)}>
            {mode === "boarding" && !caregiver.providerId ? "Choose an available host" : `Continue with ${caregiver.name.split(" ")[0]}`}
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
            {mode === "boarding" && <p className={styles.hint}>Pet Taxi pricing is not enabled in Boarding Gate 1 and is excluded from the canonical quote.</p>}
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
              Pets<b>{selectedPetNames.join(" + ")}</b>
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
                {caregiver.name} · {caregiver.rating} ★ · {mode === "boarding" ? `${caregiver.model === "full_time" ? "full-time" : "commission"} host` : "commission partner"}
              </b>
            </span>
            <span>
              Partner approval<b>{mode === "boarding" ? "Host acceptance follows the canonical booking request" : "Accepted offer · final calendar approval required"}</b>
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
            {mode !== "boarding" && <span>
              PawSpace protection & 24/7 support<b>{money(protection)}</b>
            </span>}
            {false && taxi && mode === "boarding" && (
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
                <em>MORE THAN 4 NIGHTS</em>
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
                <b>{mode === "boarding" ? "Full prepaid UAT payment from the canonical Boarding quote" : "Full payment for hourly care and stays up to 4 nights"}</b>
                <span>
                  {"50/50 split payment becomes available automatically for overnight stays longer than four nights."}
                </span>
              </div>
            </article>
          )}
          {mode !== "boarding" && <CouponField
            service="Pet Sitting"
            orderValue={totalBeforeCoupon}
            customerId={customer.customerId}
            customerKind="existing"
            paymentMode={splitEligible && splitPayment ? "partial" : "full"}
            onDiscountChange={(value, code) => {
              setDiscount(value);
              setCouponCode(code);
            }}
          />}
          {mode === "boarding" && <p className={styles.hint}>Boarding coupons are disabled until a canonical coupon policy is configured.</p>}
          {mode !== "boarding" && discount > 0 && (
            <article className={styles.couponSaving}>Coupon saving <b>−{money(discount)}</b></article>
          )}
          <article className={styles.protection}>
            <i>✓</i>
            <div>
              <b>PawSpace Stay Protection</b>
              <span>{mode === "boarding" ? "Canonical host capacity and UAT payment are verified. Cancellation/refund policy, live messaging and 24/7 support integrations remain pre-live gates." : "Calendar and capacity verified, secure payment, caregiver replacement, cancellation/refund workflow and 24/7 incident support."}</span>
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
            {mode === "boarding" ? "Production OTP is not connected; this UAT checkout records the server-quoted payment." : "OTP is requested only now."} {money(reserveAmount)} will be collected
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
            {scheduling ? "Locking care capacity…" : mode === "boarding" ? `Pay ${money(reserveAmount)} & create canonical stay` : `Pay ${money(reserveAmount)} & request final partner approval`}
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
  if (boarding) return (
    <article className={styles.fullProfile}>
      <header className={styles.profileHeader}><div><span>GOVERNED BOARDING HOST · UAT</span><h3>{caregiver.name}</h3><p>📍 {caregiver.area} · selected-window capacity verified</p></div><b>{caregiver.rating} ★</b></header>
      <section className={styles.aboutProfile}><span>CANONICAL HOST PROFILE</span><h4>{caregiver.home}</h4><p>This view uses PawSpace host identity, verification, species eligibility and capacity records. It does not fabricate reviews, response times, media, amenities or day-by-day availability.</p></section>
      <section className={styles.amenities}><div className={styles.profileSectionHead}><b>Governed eligibility</b><span>UAT canonical</span></div><div>{caregiver.features.map(item=><span key={item}>✓ {item}</span>)}</div></section>
      <section className={styles.profileRules}><div><b>Selected stay window</b><span>{shortDate(start)}–{shortDate(end)} · {caregiver.capacity}</span></div><div><b>Availability source</b><span>Host profile + leave blocks + accepted stay locks + pending Boarding scheduler reservations.</span></div></section>
      <footer className={styles.verifiedBar}><div><b>✓ Home verified</b><b>✓ KYC verified</b><b>✓ Background verified</b><b>✓ Capacity checked</b></div><span>Media, reviews and live communications are not connected in Boarding UAT.</span></footer>
    </article>
  );
  const gallery = [
    ["/assets/stays/sitter-profile.webp", "Sitter profile"],
    ["/assets/stays/sitter-care-update.webp", "Recent care update"],
  ];
  const amenities = [
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
  flash,
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
  flash: (message: string) => void;
}) {
  return (
    <section className={styles.flow}>
      <article className={styles.success}>
        <i>✓</i>
        <div>
          <small>
            {mode === "boarding" ? "BOARDING BOOKING CREATED" : "SITTING CONFIRMED"} · {bookingId}
          </small>
          <h3>{pets.join(" + ")} are all set.</h3>
          <p>
            {shortDate(start)}–{shortDate(end)} · {nights} nights ·{" "}
            {caregiver.name} · {money(total)}
          </p>
        </div>
      </article>
      <div className={styles.status}>
        <span className={styles.done}>{mode === "boarding" ? "Booking created" : "Confirmed"}</span>
        <i />
        <span className={styles.done}>
          {taxi && mode === "boarding" ? "Taxi assigned" : mode === "boarding" ? "Awaiting host" : "Care shared"}
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
          <button onClick={() => flash("Live Pet Taxi tracking starts once the driver arrives. UAT does not simulate live GPS.")}>Track</button>
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
        mode === "boarding" ? <BoardingCustomerStayStatus bookingId={bookingId} caregiverName={caregiver.name} /> : <>
          <article className={styles.next}>
            <span>NEXT STEP</span>
            <h4>Meet & Greet · 20 Aug, 6:00 PM</h4>
            <p>
              {caregiver.name} · both sides receive 24-hour and 2-hour
              reminders.
            </p>
            <div>
              <button onClick={() => flash("Reschedule request logged. UAT does not update the caregiver's live calendar.")}>Reschedule</button>
              <button onClick={() => flash(`Opening secure chat with ${caregiver.name.split(" ")[0]}. UAT does not deliver a live message yet.`)}>Secure chat</button>
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
            <button onClick={() => flash(`Opening ${caregiver.name.split(" ")[0]}'s full profile.`)}>Profile</button>
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
        mode === "boarding" ? <BoardingCustomerStayPanel bookingId={bookingId} caregiverName={caregiver.name} /> : <>
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
          <button className={styles.primary} onClick={() => flash(`Opening secure chat with ${caregiver.name.split(" ")[0]}. UAT does not deliver a live message yet.`)}>
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
            <button onClick={() => flash("Care Desk notified about a pet health concern. In production this connects you to a live agent within minutes; UAT does not place a real call.")}>
              ⚕ Pet health concern<small>Connect Care Desk</small>
            </button>
            <button onClick={() => flash("Priority ticket logged: unable to reach caregiver. In production this pages PawSpace Operations immediately; UAT does not send a live alert.")}>
              ! Cannot reach caregiver<small>Open priority ticket</small>
            </button>
            <button onClick={() => flash("Early pickup request logged for coordination with your caregiver. UAT does not send a live message.")}>
              ↻ Need early pickup<small>Coordinate safely</small>
            </button>
            <button onClick={() => flash("Payment/refund query logged for Finance review. UAT does not open a live case yet.")}>
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
