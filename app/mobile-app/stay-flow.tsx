"use client";
import { useEffect, useMemo, useState } from "react";
import styles from "./stay-flow.module.css";
import { staySearchKey, canPlanStay, currentBoardingHost } from "../../lib/stay-search-state";
import { createTestTransaction } from "../../lib/test-transaction";
import SittingCustomerPanel from "./sitting-customer-panel";
import PetManager from "./pet-manager";
import { loadCustomerPets, type CustomerPet } from "../../lib/customer-account-client";
import { reserveUatSchedule, previewSitters } from "../../lib/uat-scheduling-client";
import { createCanonicalLifecycle } from "../../lib/canonical-lifecycle-client";
import { loadBoardingCommercial, quoteBoarding, type BoardingHost, type BoardingQuote } from "../../lib/boarding-commercial-client";
import BoardingCustomerStayPanel from "./boarding-customer-stay-panel";
import BoardingCustomerStayStatus from "./boarding-customer-stay-status";
import AddressPicker, { type ZoneResult } from "./address-picker";
import { createSittingQuote, type SittingQuote } from "../../lib/sitting-commercial-client";
import { captureSittingQuoteSandbox } from "../../lib/sitting-payment-client";
import { createCanonicalSittingBooking } from "../../lib/sitting-booking-client";

// Unique per-booking nonce. Kept as a module-scope helper so the impure Date.now()
// call lives outside component render (matching istDate in the taxi/walking flows).
const bookingNonce = () => Date.now();
const careWindowDates=(start:string,end:string,window:CareWindow)=>{const scheduledStart=new Date(`${start}T03:30:00.000Z`),scheduledEnd=window==="24 hours"?new Date(`${end}T03:30:00.000Z`):new Date(scheduledStart.getTime()+(window==="10 hours"?10:window==="12 hours"?12:4)*3_600_000);return{scheduledStart,scheduledEnd};};

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
const sitterPlaceholder: Caregiver = {name:"Select an available sitter",initials:"PS",area:"",rating:"",price:0,badge:"",home:"",features:[],capacity:"Availability required"};
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
    [selRaw, setSelectedPets] = useState<string[]>([]),
    [petsState, setPets] = useState<CustomerPet[] | null>(null),
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
    [sitters,setSitters] = useState<Caregiver[]>([]),
    [sitterWindowKey,setSitterWindowKey] = useState(""),
    [sitterError,setSitterError] = useState(""),
    [caregiver, setCaregiver] = useState<Caregiver>(
      initialMode === "boarding" ? boardingPlaceholder : sitterPlaceholder,
    ),
    [boardingHosts, setBoardingHosts] = useState<Caregiver[]>([]),
    [boardingHostWindowKey, setBoardingHostWindowKey] = useState(""),
    [boardingHostError, setBoardingHostError] = useState(""),
    [hostRetry, setHostRetry] = useState(0),
    [meet, setMeet] = useState(true),
    [meetFormat, setMeetFormat] = useState<"visit" | "call">("visit"),
    [taxi, setTaxi] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [agreed, setAgreed] = useState(true),
    [start, setStart] = useState(() => dateOffset(3)),
    [end, setEnd] = useState(() => dateOffset(10)),
    [bookingId, setBookingId] = useState(""),
    [confirmedTotal, setConfirmedTotal] = useState<number | null>(null),
    [scheduling, setScheduling] = useState(false),
    [scheduleError, setScheduleError] = useState(""),
    [profileOpen, setProfileOpen] = useState(true),
    [splitPayment, setSplitPayment] = useState(true),
    [serviceLocation, setServiceLocation] = useState<ZoneResult | null>(null),
    [sittingQuote, setSittingQuote] = useState<SittingQuote | null>(null),
    [sittingQuoteError, setSittingQuoteError] = useState(""),
    [boardingQuote, setBoardingQuote] = useState<BoardingQuote | null>(null),
    [chatOpen, setChatOpen] = useState(false),
    [view, setView] = useState<View>("stay"),
    [toast, setToast] = useState("");
  const flash = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  };
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) setPetsLoading(true);
    });
    loadCustomerPets(customer.customerId)
      .then((loaded) => {
        if (!active) return;
        setPets((prev) => (prev === null ? loaded : prev));
        setSelectedPets((prev) => (prev.length ? prev : loaded[0] ? [loaded[0].id] : []));
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
  const pets = petsState ?? [];
  const selectedPets = useMemo(() => selRaw.filter((id) => petsState?.some((p) => p.id === id)), [selRaw,petsState]);
  const selectedPetObjs = pets.filter((p) => selectedPets.includes(p.id));
  const selectedPetNames = selectedPetObjs.map((p) => p.name);
  const selectedSpecies = [...new Set(selectedPetObjs.map((p) => p.species).filter((value): value is string => Boolean(value)))];
  const selectedSpeciesKey = selectedSpecies.join(",");
  const boardingHostQueryKey = staySearchKey({cityId:serviceLocation?.assignment.cityId,zoneId:serviceLocation?.assignment.zoneId,location:serviceLocation?`${serviceLocation.placeId}|${serviceLocation.latitude}|${serviceLocation.longitude}|${serviceLocation.address}`:"",start,end,careWindow,petIds:selectedPets,species:selectedSpecies});
  const caregivers = mode === "boarding" ? (boardingHostWindowKey === boardingHostQueryKey ? boardingHosts : []) : (sitterWindowKey === boardingHostQueryKey ? sitters : []);
  const selectedBoardingHost = currentBoardingHost(boardingHosts,caregiver.providerId,boardingHostWindowKey,boardingHostQueryKey);
  const selectedSitter = currentBoardingHost(sitters,caregiver.providerId,sitterWindowKey,boardingHostQueryKey);
  const showCaregiver = mode === "boarding" ? Boolean(selectedBoardingHost) : Boolean(selectedSitter);
  const nights = Math.max(
    0,
    Math.ceil(
      (new Date(`${end}T00:00:00`).getTime() -
        new Date(`${start}T00:00:00`).getTime()) /
        86_400_000,
    ),
  );
  const datesValid = careWindow === "24 hours" ? nights > 0 : Boolean(start);
  const extraPets = Math.max(0, selectedPets.length - 1);
  const boardingUnitPrice=boardingQuote?.basePricePerPet??0,boardingUnits=boardingQuote?.stayUnits??0;
  const base = mode === "boarding" ? boardingUnitPrice*boardingUnits : (sittingQuote?.basePricePerPet??0)*(sittingQuote?.billableUnits??0);
  const extra = mode === "boarding" ? extraPets*boardingUnitPrice*boardingUnits : extraPets*(sittingQuote?.extraPetPrice??0)*(sittingQuote?.billableUnits??0);
  const protection = 0;
  const taxiFee = 0;
  const meetFee = 0;
  const total = mode === "boarding" ? boardingQuote?.totalAmount??0 : sittingQuote?.totalAmount??0;
  const splitEligible = careWindow === "24 hours" && nights > 4;
  const reserveAmount = mode === "boarding" ? boardingQuote?.amountDueNow??0 : sittingQuote?.amountDueNow??0;
  const balanceAmount = mode === "boarding"
    ? Math.max(0, (boardingQuote?.totalAmount??0) - (boardingQuote?.amountDueNow??0))
    : Math.max(0,(sittingQuote?.totalAmount??0)-(sittingQuote?.amountDueNow??0));
  useEffect(()=>{if(mode!=="sitting"||!serviceLocation||selectedPets.length===0){queueMicrotask(()=>setSittingQuote(null));return;}let active=true;const{scheduledStart,scheduledEnd}=careWindowDates(start,end,careWindow),packageCode=careWindow==="24 hours"?"sitting-overnight":"sitting-visit-60",paymentMode=splitEligible&&splitPayment?"split_50_50":"prepaid";queueMicrotask(()=>{if(active){setSittingQuote(null);setSittingQuoteError("");}});void createSittingQuote({packageCode,petCount:selectedPets.length,cityId:serviceLocation.assignment.cityId,zoneId:serviceLocation.assignment.zoneId,scheduledStart:scheduledStart.toISOString(),scheduledEnd:scheduledEnd.toISOString(),paymentMode}).then(value=>{if(active)setSittingQuote(value);}).catch(problem=>{if(active)setSittingQuoteError(problem instanceof Error?problem.message:"Unable to create canonical Sitting quote");});return()=>{active=false;};},[mode,serviceLocation,start,end,careWindow,selectedPets.length,splitEligible,splitPayment]);
  useEffect(()=>{if(mode!=="boarding"||!serviceLocation||selectedPets.length===0)return;let active=true;const{scheduledStart,scheduledEnd}=careWindowDates(start,end,careWindow),packageCode=careWindow==="4 hours"?"boarding-4h":careWindow==="10 hours"?"boarding-10h":"boarding-24h";void quoteBoarding({packageCode,petCount:selectedPets.length,cityId:serviceLocation.assignment.cityId,zoneId:serviceLocation.assignment.zoneId,scheduledStart:scheduledStart.toISOString(),scheduledEnd:scheduledEnd.toISOString(),paymentMode:splitEligible&&splitPayment?"split_50_50":"prepaid"}).then(value=>{if(active){setBoardingQuote(value);setScheduleError("");}}).catch(problem=>{if(active){setBoardingQuote(null);setScheduleError(problem instanceof Error?problem.message:"Unable to refresh Boarding quote");}});return()=>{active=false;};},[mode,serviceLocation,careWindow,start,end,selectedPets.length,splitEligible,splitPayment]);
  useEffect(()=>{if(mode!=="boarding"||!serviceLocation||selectedPets.length===0)return;let active=true;const queryKey=boardingHostQueryKey,{scheduledStart,scheduledEnd}=careWindowDates(start,end,careWindow);void loadBoardingCommercial({cityId:serviceLocation.assignment.cityId,zoneId:serviceLocation.assignment.zoneId,scheduledStart:scheduledStart.toISOString(),scheduledEnd:scheduledEnd.toISOString(),petCount:selectedPets.length,species:selectedSpeciesKey?selectedSpeciesKey.split(","):[]}).then(data=>{if(!active)return;const hosts=data.hosts.map(toBoardingCaregiver);setBoardingHosts(hosts);setBoardingHostWindowKey(queryKey);setBoardingHostError("");setCaregiver(current=>hosts.find(host=>host.providerId===current.providerId)??hosts[0]??boardingPlaceholder);}).catch(problem=>{if(!active)return;setBoardingHosts([]);setBoardingHostWindowKey(queryKey);setBoardingHostError(problem instanceof Error?problem.message:"Unable to load Boarding host availability");setCaregiver(boardingPlaceholder);});return()=>{active=false;};},[mode,serviceLocation,careWindow,start,end,selectedPets.length,boardingHostQueryKey,selectedSpeciesKey,hostRetry]);
  useEffect(()=>{
   if(mode!=="sitting"||!serviceLocation||!datesValid||!selectedPets.length)return;
   let active=true;const queryKey=boardingHostQueryKey,{scheduledStart,scheduledEnd}=careWindowDates(start,end,careWindow);
   void previewSitters({clientRequestId:`preview:${queryKey}`,customerId:customer.customerId,petIds:selectedPets,serviceCode:"pet_sitting",serviceAddress:serviceLocation.address,servicePincode:serviceLocation.assignment.pincode,scheduledStart:scheduledStart.toISOString(),scheduledEnd:scheduledEnd.toISOString(),careMode:careWindow==="24 hours"?"overnight":"visit"}).then(data=>{if(!active)return;const rows:Caregiver[]=data.providers.map(provider=>({...sitterPlaceholder,providerId:provider.id,name:provider.name,model:provider.model,initials:hostInitials(provider.name),area:serviceLocation.assignment.area,badge:"Available for this window",home:"Availability checked against the current schedule. Confirmation rechecks the slot.",availabilityVerified:true}));setSitters(rows);setSitterWindowKey(queryKey);setSitterError("");setCaregiver(current=>rows.find(row=>row.providerId===current.providerId)??rows[0]??sitterPlaceholder);}).catch(problem=>{if(active){setSitters([]);setSitterWindowKey(queryKey);setSitterError(problem instanceof Error?problem.message:"Unable to load sitters");setCaregiver(sitterPlaceholder);}});return()=>{active=false;};
  },[mode,serviceLocation,datesValid,selectedPets,boardingHostQueryKey,customer.customerId,start,end,careWindow,hostRetry]);
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
    setCaregiver(next === "boarding" ? boardingPlaceholder : sitterPlaceholder);
    if(next==="boarding"&&careWindow==="12 hours")setCareWindow("10 hours");
    if(next==="sitting"&&careWindow==="10 hours")setCareWindow("12 hours");
    setTaxi(false);
    setProfileOpen(true);
  };
  const confirm = async () => {
    if (!datesValid || !agreed) return;
    if (selectedPets.length === 0) { setScheduleError("Select at least one pet to continue."); return; }
    if (!serviceLocation) { setScheduleError("Verify the service address before continuing."); return; }
    if (mode === "sitting" && !sittingQuote) { setScheduleError(sittingQuoteError || "Wait for the canonical Sitting quote."); return; }
    if (mode === "boarding" && selectedPetObjs.some((pet) => pet.vaccinationStatus !== "verified")) { setScheduleError("Boarding requires verified vaccination for every selected pet."); return; }
    setScheduling(true);setScheduleError("");
    try {
    if(mode==="sitting"&&!selectedSitter)throw new Error("Select a currently available sitter before confirming");
    const{scheduledStart:scheduleStart,scheduledEnd:scheduleEnd}=careWindowDates(start,end,careWindow),zoneId=serviceLocation.assignment.zoneId;
    const boardingCommercial=mode==="boarding"?await loadBoardingCommercial({cityId:serviceLocation.assignment.cityId,zoneId,scheduledStart:scheduleStart.toISOString(),scheduledEnd:scheduleEnd.toISOString(),petCount:selectedPets.length,species:selectedSpecies}):null,governedHost=boardingCommercial?.hosts.find(item=>item.providerId===caregiver.providerId);if(mode==="boarding"&&!governedHost)throw new Error("Selected Boarding host is no longer available for this stay window");
    const packageCode=careWindow==="4 hours"?"boarding-4h":careWindow==="10 hours"?"boarding-10h":"boarding-24h",governedBoardingQuote=mode==="boarding"?await quoteBoarding({packageCode,petCount:selectedPets.length,cityId:serviceLocation.assignment.cityId,zoneId,scheduledStart:scheduleStart.toISOString(),scheduledEnd:scheduleEnd.toISOString(),paymentMode:splitEligible&&splitPayment?"split_50_50":"prepaid"}):null;
    const requestId=`${mode}-${customer.customerId}-${start}-${end}-${careWindow.replaceAll(" ","")}-${selectedPets.length}-${bookingNonce()}`,decision=await reserveUatSchedule({clientRequestId:requestId,customerId:customer.customerId,petIds:selectedPets,serviceCode:mode==="boarding"?"boarding":"pet_sitting",cityId:serviceLocation.assignment.cityId,zoneId,scheduledStart:scheduleStart.toISOString(),scheduledEnd:scheduleEnd.toISOString(),careMode:careWindow==="24 hours"?"overnight":"visit",preferredProviderId:mode==="boarding"?governedHost?.providerId:selectedSitter?.providerId});
    let canonicalBookingId:string;
    if(mode==="sitting"){
      const quote=sittingQuote!;await captureSittingQuoteSandbox({quoteId:quote.quoteId,amount:quote.amountDueNow});const result=await createCanonicalSittingBooking({idempotencyKey:`sitting:${quote.quoteId}:${customer.customerId}`,groupId:decision.groupId,sittingQuoteId:quote.quoteId,customer:{id:customer.customerId,name:customer.customerName,primaryPhone:customer.phone},pets:selectedPetObjs.map(p=>({sourceId:p.sourceId??p.id,name:p.name,species:p.species==="cat"?"cat":p.species==="dog"?"dog":"other",vaccinationStatus:"not_provided"})),cityId:serviceLocation.assignment.cityId,zoneId,packageCode:quote.packageCode,packageName:quote.packageName,scheduledStart:quote.scheduledStart,scheduledEnd:quote.scheduledEnd,provider:decision.provider,totalAmount:quote.totalAmount,amountDueNow:quote.amountDueNow,payment:{method:"payment_link",mode:quote.paymentMode,detail:"Server-attested Sitting UAT sandbox capture"}});canonicalBookingId=result.bookingId;
    }else{
      const quote=governedBoardingQuote!;const result=await createCanonicalLifecycle({idempotencyKey:requestId,scheduleGroupId:decision.groupId,customer:{id:customer.customerId,name:customer.customerName,primaryPhone:customer.phone},pets:selectedPetObjs.map(p=>({sourceId:p.sourceId??p.id,name:p.name,species:p.species==="cat"?"cat":p.species==="dog"?"dog":"other" as const,vaccinationStatus:p.vaccinationStatus})),cityId:serviceLocation.assignment.cityId,zoneId,serviceCode:"boarding",packageCode:quote.packageCode,packageName:quote.packageName,scheduledStart:scheduleStart.toISOString(),scheduledEnd:scheduleEnd.toISOString(),provider:decision.provider,totalAmount:quote.totalAmount,amountDueNow:quote.amountDueNow,payment:{method:"upi",mode:quote.paymentMode,status:"captured",detail:"UAT Boarding sandbox payment from server quote"},pricing:{discount:0,boardingQuoteId:quote.quoteId}});canonicalBookingId=result.bookingId;
    }
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
      offerCode: undefined,
      discount: 0,
      payment:
        mode === "boarding"
          ? splitEligible && splitPayment
            ? `50% deposit paid in UAT sandbox from canonical Boarding quote · ${money(balanceAmount)} due 24 hours before check-in`
            : "Paid in UAT sandbox from canonical Boarding quote"
          : splitEligible && splitPayment
            ? `50% stay deposit + Meet & Greet paid · ${money(balanceAmount)} due 24 hours before check-in`
            : "Server-attested Sitting UAT sandbox payment",
      provider: decision.provider.name,
      providerModel: "Commission",
      subscription: "No active plan",
      creditsBefore: 0,
      crmOwner: "Asha",
      crmNextAction: "Commission caregiver approval, secure chat and Meet & Greet",
      reminder: "Care Card and emergency-contact updates queued",
    },canonicalBookingId);
    setConfirmedTotal(governedBoardingQuote?.totalAmount ?? sittingQuote?.totalAmount ?? total);
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
          total={confirmedTotal??total}
          taxi={taxi}
          view={view}
          setView={setView}
          flash={flash}
        />
      </>
    );
  return (
    <section className={styles.flow}>
      <header className={styles.stayIntro}><span>{mode === "boarding" ? "PAWSPACE BOARDING" : "PAWSPACE SITTING"}</span><div><h2>{mode === "boarding" ? "A stay that feels like home." : "Care at home, around their routine."}</h2><small>Plan the stay, choose the right caregiver, then confirm together.</small></div><b>{stage}<i>/4</i></b></header>
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
          <AddressPicker onZoneResolved={setServiceLocation}/>
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
            disabled={!canPlanStay({datesValid,petCount:selectedPets.length,serviceAvailable:serviceLocation?.zone.serviceAvailable})}
            className={styles.primary}
            onClick={() => {if(canPlanStay({datesValid,petCount:selectedPets.length,serviceAvailable:serviceLocation?.zone.serviceAvailable}))setStage(2);}}
          >
            {selectedPets.length === 0
              ? "Select a pet to continue"
              : !serviceLocation?.zone.serviceAvailable ? "Verify a service address to continue"
              : `See available ${mode === "boarding" ? "homes" : "sitters"}`}
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
          ) : <article className={styles.matchIntro}><div><b>Available sitters for your care window</b><span>Choose a sitter from the current schedule. No request or offer is sent until you confirm.</span></div></article>}
          {mode === "sitting" && sitterWindowKey !== boardingHostQueryKey && <p role="status">Checking sitter availability…</p>}
          {mode === "sitting" && sitterWindowKey === boardingHostQueryKey && !caregivers.length && <p role="alert">{sitterError||"No sitter is available for this care window. Try different dates."}</p>}
          {mode === "sitting" && sitterError && <button onClick={()=>{setSitterWindowKey("");setSitterError("");setHostRetry(value=>value+1);}}>Retry sitter search</button>}
          {mode === "boarding" && !serviceLocation && <p role="alert">Return to trip details and verify a service address before searching for hosts.</p>}
          {mode === "boarding" && serviceLocation && boardingHostWindowKey !== boardingHostQueryKey && <p className={styles.hint}>Checking governed host availability for this stay window…</p>}
          {mode === "boarding" && boardingHostWindowKey === boardingHostQueryKey && caregivers.length === 0 && <p role="alert" className={styles.hint}>{boardingHostError || "No verified Boarding host currently has capacity for every selected pet in this UAT window."}</p>}
          {mode === "boarding" && boardingHostError && <button onClick={()=>{setBoardingHostWindowKey("");setBoardingHostError("");setHostRetry(value=>value+1);}}>Retry host search</button>}
          <div className={styles.caregivers}>
            {caregivers.map((c) => (
              <button
                key={c.providerId ?? c.name}
                className={caregiver.name === c.name ? styles.selected : ""}
                onClick={() => {
                  setCaregiver(c);
                  setProfileOpen(true);
                }}
              >
                <div className={styles.caregiverTop}>
                  <i>{c.initials}</i>
                  <div>
                    <span>{c.badge}</span>
                    <h4>{c.name}</h4>
                  <small>
                    {mode === "boarding" ? `📍 ${c.area} · selected-window capacity checked` : `📍 ${c.area} · availability checked`}
                  </small>
                  </div>
                </div>
                <p>{c.home}</p>
                <div className={styles.tags}>
                  {c.features.map((f) => (
                    <span key={f}>✓ {f}</span>
                  ))}
                </div>
                <div className={styles.caregiverFoot}>
                  <span>
                    {mode === "boarding" && <b>{c.rating} ★</b>}
                    {mode === "boarding" ? `${c.availableGuestPets ?? 0} guest-pet spots available` : "Reviews are not connected"}
                  </span>
                  <strong>
                    {money(mode === "boarding" ? (boardingQuote?.basePricePerPet ?? 0) : (sittingQuote?.basePricePerPet ?? 0))}
                    <small>{mode === "boarding" ? " / pet / stay unit" : " / night"}</small>
                  </strong>
                </div>
                {mode === "boarding" ? (
                  <label>✓ Governed host · selected-window availability verified in UAT</label>
                ) : <>
                  <label>UAT profile · final assignment is decided by the canonical scheduler</label>
                </>}
              </button>
            ))}
          </div>
          {showCaregiver && <article className={styles.profileNote}>
            <div>
              <b>
                {caregiver.name} · {caregiver.capacity}
              </b>
              <span>
                {mode === "boarding" ? "Identity, species eligibility and stay capacity come from PawSpace governed records. Host media and customer reviews are not connected in Boarding UAT." : "Availability comes from the current schedule. Profiles, reviews and live messaging are not connected."}
              </span>
            </div>
            <button onClick={() => setProfileOpen((open) => !open)}>
              {profileOpen ? "Hide profile" : "View full profile"}
            </button>
            <button onClick={() => setChatOpen((open) => !open)}>
              {chatOpen ? "Close chat" : "Chat securely"}
            </button>
          </article>}
          {showCaregiver && chatOpen && (
            mode === "boarding" ? <article className={styles.secureChat}><header><b>Boarding chat</b><span>UAT boundary</span></header><p>Live masked chat is not connected yet. This screen does not simulate host messages.</p></article> : <article className={styles.secureChat}><header><b>Sitter chat</b></header><p>Live sitter messaging is not connected. No message has been sent.</p></article>
          )}
          {showCaregiver && profileOpen && (
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
          <button className={styles.primary} disabled={!showCaregiver} onClick={() => {if(showCaregiver)setStage(3);}}>
            {!showCaregiver ? "Choose an available caregiver" : `Continue with ${caregiver.name.split(" ")[0]}`}
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
          <button className={styles.back} onClick={() => {if(canPlanStay({datesValid,petCount:selectedPets.length,serviceAvailable:serviceLocation?.zone.serviceAvailable}))setStage(2);}}>
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
                {caregiver.name}{mode === "boarding" ? ` · ${caregiver.rating} ★` : ""} · {mode === "boarding" ? `${caregiver.model === "full_time" ? "full-time" : "commission"} host` : "commission partner"}
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
          <p className={styles.hint}>{mode === "boarding" ? "Boarding" : "Pet Sitting"} coupons are disabled until that service has an explicit canonical redemption policy.</p>
          {mode === "sitting" && sittingQuoteError && <p role="alert">{sittingQuoteError}</p>}
          <article className={styles.protection}>
            <i>✓</i>
            <div>
              <b>PawSpace Stay Protection</b>
              <span>{mode === "boarding" ? "Canonical host capacity and UAT payment are verified. Cancellation/refund policy, live messaging and 24/7 support integrations remain pre-live gates." : "The canonical quote is ready. Sitter capacity is confirmed only when the scheduler accepts this request; payment remains UAT sandbox-only."}</span>
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
            disabled={!agreed || !datesValid || scheduling || selectedPets.length === 0 || !serviceLocation || (mode === "sitting" && !sittingQuote)}
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
  if (boarding && (!caregiver.providerId || !caregiver.availabilityVerified)) return null;
  if (boarding) return (
    <article className={styles.fullProfile}>
      <header className={styles.profileHeader}><div><span>GOVERNED BOARDING HOST · UAT</span><h3>{caregiver.name}</h3><p>📍 {caregiver.area} · selected-window capacity verified</p></div><b>{caregiver.rating} ★</b></header>
      <section className={styles.aboutProfile}><span>CANONICAL HOST PROFILE</span><h4>{caregiver.home}</h4><p>This view uses PawSpace host identity, verification, species eligibility and capacity records. It does not fabricate reviews, response times, media, amenities or day-by-day availability.</p></section>
      <section className={styles.amenities}><div className={styles.profileSectionHead}><b>Governed eligibility</b><span>UAT canonical</span></div><div>{caregiver.features.map(item=><span key={item}>✓ {item}</span>)}</div></section>
      <section className={styles.profileRules}><div><b>Selected stay window</b><span>{shortDate(start)}–{shortDate(end)} · {caregiver.capacity}</span></div><div><b>Availability source</b><span>Host profile + leave blocks + accepted stay locks + pending Boarding scheduler reservations.</span></div></section>
      <footer className={styles.verifiedBar}><div><b>✓ Home verified</b><b>✓ KYC verified</b><b>✓ Background verified</b><b>✓ Capacity checked</b></div><span>Media, reviews and live communications are not connected in Boarding UAT.</span></footer>
    </article>
  );
  return <article className={styles.fullProfile}><h3>{caregiver.name}</h3><p>{caregiver.area} · {caregiver.model === "full_time" ? "Full-time sitter" : "Commission sitter"}</p><p>Available for the selected care window when last checked. Confirmation rechecks availability.</p><p>Profile photos, ratings, reviews and live messaging are not connected.</p></article>;
}

function Head({ title, note }: { title: string; note: string }) {
  return (
    <div className={styles.head}>
      <h3>{title}</h3>
      <small>{note}</small>
    </div>
  );
}
function LiveStay({bookingId,mode,caregiver,view,setView}:{bookingId:string;start:string;end:string;nights:number;mode:Mode;caregiver:Caregiver;pets:string[];total:number;taxi:boolean;view:View;setView:(value:View)=>void;flash:(message:string)=>void}){
 if(mode === "sitting")return <SittingCustomerPanel key={bookingId} bookingId={bookingId} />;
 return <section className={styles.flow}><h2>Boarding booking · {bookingId}</h2><nav aria-label="Boarding booking sections" className={styles.liveTabs}><button onClick={()=>setView("stay")}>Stay status</button><button onClick={()=>setView("care")}>Care and requests</button></nav>{view === "stay"?<BoardingCustomerStayStatus bookingId={bookingId} caregiverName={caregiver.name}/>:<BoardingCustomerStayPanel bookingId={bookingId} caregiverName={caregiver.name}/>}</section>;
}
