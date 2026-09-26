"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./stay-flow.module.css";
import Link from "next/link";
import {boardingCareDraft} from "../../lib/boarding-customer-care";
import type {SittingCarePlan} from "../../lib/sitting-lifecycle";
import { staySearchKey, canPlanStay, currentBoardingHost } from "../../lib/stay-search-state";
import StayMeetingRequest,{type StayMeeting} from "./stay-meeting-request";
import CaregiverPublicProfile from "./caregiver-public-profile";
import SittingCustomerPanel from "./sitting-customer-panel";
import PetManager from "./pet-manager";
import { loadCustomerPets, type CustomerPet } from "../../lib/customer-account-client";
import { reserveUatSchedule, previewSitters, isAvailabilityPending, type UatScheduleRequest, type UatScheduleResult } from "../../lib/uat-scheduling-client";
import { createCanonicalLifecycle } from "../../lib/canonical-lifecycle-client";
import { loadBoardingCommercial, quoteBoarding, type BoardingHost, type BoardingQuote } from "../../lib/boarding-commercial-client";
import BoardingCustomerStayPanel from "./boarding-customer-stay-panel";
import BoardingCustomerStayStatus from "./boarding-customer-stay-status";
import StayAddress from "./stay-address";
import type { StayLocation } from "../../lib/stay-saved-address";
import { stayCareWindow, homeVisitEnd } from "../../lib/stay-care-window";
import { createSittingQuote, type SittingQuote } from "../../lib/sitting-commercial-client";
import { createCanonicalSittingBooking } from "../../lib/sitting-booking-client";
import StayCarePaymentGate from "./stay-care-payment-gate";
import BookingReferenceRecovery from "./booking-reference-recovery";
import {boardingRequirements} from "../../lib/stay-host-requirements";
import {useInitialBookingReference} from "../../lib/use-initial-booking-reference";
import {indiaDateOffset,rememberBookingReference,sameReviewedStayQuote} from "../../lib/customer-booking-safety";

type Mode = "boarding" | "sitting";
type View = "stay" | "care" | "support";
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
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(n);
const dateOffset = indiaDateOffset;
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

/*
 * Availability searches on the Plan step (round-2 tester: four overlapping sitter searches before Continue).
 * A search starts only once the fields have stopped changing for STAY_SEARCH_SETTLE_MS, and a search that a
 * newer one replaced is cancelled rather than left running on the server. A search that does not finish is
 * "still checking" with a retry - it never reads as "no sitter / host is available".
 */
const STAY_SEARCH_SETTLE_MS = 700;
const SITTER_STILL_CHECKING = "Still checking sitter availability for this care window - it is taking longer than usual. Tap Retry sitter search.";
/** One automatic retry after the server's Retry-After when a sitter search did not finish, then the answer. */
async function previewSittersPatiently(request: UatScheduleRequest, signal: AbortSignal) {
  try { return await previewSitters(request, { signal }); } catch (problem) {
    if (!isAvailabilityPending(problem) || signal.aborted) throw problem;
    const waitSeconds = Math.min(10, Math.max(1, problem.retryAfterSeconds));
    await new Promise<void>((resolve) => { const timer = window.setTimeout(resolve, waitSeconds * 1000); signal.addEventListener("abort", () => { window.clearTimeout(timer); resolve(); }, { once: true }); });
    if (signal.aborted) throw problem;
    return previewSitters(request, { signal });
  }
}
export default function StayFlow({ mode: initialMode, customer, onModeChange, routeScope="legacy" }: { routeScope?:"legacy"|"v2"; mode: Mode; customer: LoggedInCustomer; onModeChange?:(mode:Mode)=>void }) {
  const actionLock=useRef(false);
  const[meeting,setMeeting]=useState<StayMeeting|null>(null);
  const bookingAttempt=useRef<{key:string;id:string;host?:BoardingHost;boarding?:BoardingQuote;sitting?:SittingQuote;schedule?:UatScheduleResult}|null>(null);
  const recoveryBookingId=useInitialBookingReference();
  const [boardingQuotedKey,setBoardingQuotedKey]=useState(""),[sittingQuotedKey,setSittingQuotedKey]=useState("");
 const [careDraft,setCareDraft]=useState<SittingCarePlan>({}),[confirmedCarePlan,setConfirmedCarePlan]=useState<SittingCarePlan|undefined>(),[careSaveError,setCareSaveError]=useState("");
  const [mode, setMode] = useState<Mode>(initialMode),
    [stage, setStage] = useState(1),
    [selRaw, setSelectedPets] = useState<string[]>([]),
    [petsState, setPets] = useState<CustomerPet[] | null>(null),
    [petsLoading, setPetsLoading] = useState(true),
    [petsError, setPetsError] = useState(""),
    [showPetManager, setShowPetManager] = useState(false),
    [selectedNeeds, setSelectedNeeds] = useState<string[]>([]),
    [selectedBenefits, setSelectedBenefits] = useState<string[]>([]),
    [startTime, setStartTime] = useState("09:00"),
    [endTimeInput, setEndTime] = useState("09:00"),
    [foodType, setFoodType] = useState(""),
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
    [taxi, setTaxi] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [agreed, setAgreed] = useState(false),
    [start, setStart] = useState(() => dateOffset(3)),
    [endInput, setEnd] = useState(() => dateOffset(10)),
    [bookingId, setBookingId] = useState(""),
    [confirmedTotal, setConfirmedTotal] = useState<number | null>(null),
    [scheduling, setScheduling] = useState(false),
    [scheduleError, setScheduleError] = useState(""),
    [profileOpen, setProfileOpen] = useState(true),
    [splitPayment, setSplitPayment] = useState(true),
    [serviceLocation, setServiceLocation] = useState<StayLocation | null>(null),
    [sittingQuote, setSittingQuote] = useState<SittingQuote | null>(null),
    [sittingQuoteError, setSittingQuoteError] = useState(""),
    [boardingQuote, setBoardingQuote] = useState<BoardingQuote | null>(null),
    [boardingQuoteError, setBoardingQuoteError] = useState(""),
    [quoteRetry, setQuoteRetry] = useState(0),
    [chatOpen, setChatOpen] = useState(false),
    [view, setView] = useState<View>("stay"),
    [toast, setToast] = useState(""),
    [pendingPayment,setPendingPayment]=useState<{bookingId:string;serviceName:string;total:number;dueNow:number;mode:"prepaid"|"split_50_50"}|null>(null);
  // SIT-04 (owner decision): a Pet Sitting Home Visit is one 60-minute visit from the chosen start; only Overnight has a check-out.
  const [sittingCare, setSittingCare] = useState<"visit" | "overnight">("overnight");
  const visitMode = mode === "sitting" && sittingCare === "visit", visitEnd = visitMode ? homeVisitEnd(start, startTime) : null;
  const end = visitMode ? visitEnd?.date ?? start : endInput, endTime = visitMode ? visitEnd?.time ?? startTime : endTimeInput;
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
  const stayWindow = stayCareWindow(start, end, startTime, endTime);
  const careWindow = stayWindow.overnight ? "24 hours" : stayWindow.hours <= 4 ? "4 hours" : mode === "boarding" ? "10 hours" : "12 hours";
  const boardingHostQueryKey = staySearchKey({cityId:serviceLocation?.assignment.cityId,zoneId:serviceLocation?.assignment.zoneId,location:serviceLocation?`${serviceLocation.placeId}|${serviceLocation.latitude}|${serviceLocation.longitude}|${serviceLocation.address}`:"",start,end,careWindow:stayWindow.key,startTime,petIds:selectedPets,species:selectedSpecies,requirements:selectedNeeds});
  const caregivers = mode === "boarding" ? (boardingHostWindowKey === boardingHostQueryKey ? boardingHosts : []) : (sitterWindowKey === boardingHostQueryKey ? sitters : []);
  const selectedBoardingHost = currentBoardingHost(boardingHosts,caregiver.providerId,boardingHostWindowKey,boardingHostQueryKey);
  const selectedSitter = currentBoardingHost(sitters,caregiver.providerId,sitterWindowKey,boardingHostQueryKey);
  const showCaregiver = mode === "boarding" ? Boolean(selectedBoardingHost) : Boolean(selectedSitter);
  const nights = stayWindow.nights;
  const overnightTooShort = mode === "sitting" && !visitMode && stayWindow.valid && !stayWindow.overnight;
  const datesValid = stayWindow.valid && !overnightTooShort;
  const extraPets = Math.max(0, selectedPets.length - 1);
  const reviewKey=JSON.stringify([mode,boardingHostQueryKey,caregiver.providerId,splitPayment]);
  const activeQuote = mode === "boarding" ? (boardingQuotedKey===reviewKey?boardingQuote:null) : (sittingQuotedKey===reviewKey?sittingQuote:null);
  const quoteError = mode === "boarding" ? boardingQuoteError : sittingQuoteError;
  const quoteMoney = (amount: number) => activeQuote ? money(amount) : quoteError ? "Price unavailable" : "Calculating…";
  const boardingUnitPrice=boardingQuote?.basePricePerPet??0,boardingUnits=boardingQuote?.stayUnits??0;
  const base = mode === "boarding" ? boardingUnitPrice*boardingUnits : (sittingQuote?.basePricePerPet??0)*(sittingQuote?.billableUnits??0);
  const extra = mode === "boarding" ? extraPets*boardingUnitPrice*boardingUnits : extraPets*(sittingQuote?.extraPetPrice??0)*(sittingQuote?.billableUnits??0);
  const protection = 0;
  const taxiFee = 0;
  const currentMeeting=meeting&&meeting.hostProviderId===caregiver.providerId&&meeting.intendedStayStart===start&&meeting.intendedStayEnd===end?meeting:null;
  const total = mode === "boarding" ? boardingQuote?.totalAmount??0 : sittingQuote?.totalAmount??0;
  const splitEligible = careWindow === "24 hours" && nights > 4;
  const reserveAmount = mode === "boarding" ? boardingQuote?.amountDueNow??0 : sittingQuote?.amountDueNow??0;
  const balanceAmount = mode === "boarding"
    ? Math.max(0, (boardingQuote?.totalAmount??0) - (boardingQuote?.amountDueNow??0))
    : Math.max(0,(sittingQuote?.totalAmount??0)-(sittingQuote?.amountDueNow??0));
  useEffect(()=>{if(mode!=="sitting"||!serviceLocation||!datesValid||selectedPets.length===0){queueMicrotask(()=>setSittingQuote(null));return;}let active=true;const{scheduledStart,scheduledEnd}=stayCareWindow(start,end,startTime,endTime),packageCode=careWindow==="24 hours"?"sitting-overnight":"sitting-visit-60",paymentMode=splitEligible&&splitPayment?"split_50_50":"prepaid";queueMicrotask(()=>{if(active){setSittingQuote(null);setSittingQuoteError("");}});void createSittingQuote({packageCode,petCount:selectedPets.length,cityId:serviceLocation.assignment.cityId,zoneId:serviceLocation.assignment.zoneId,scheduledStart:scheduledStart.toISOString(),scheduledEnd:scheduledEnd.toISOString(),paymentMode,providerId:selectedSitter?.providerId}).then(value=>{if(active){setSittingQuote(value);setSittingQuotedKey(reviewKey);}}).catch(problem=>{if(active)setSittingQuoteError(problem instanceof Error?problem.message:"Unable to create canonical Sitting quote");});return()=>{active=false;};},[mode,serviceLocation,datesValid,start,end,careWindow,startTime,endTime,selectedPets.length,splitEligible,splitPayment,selectedSitter?.providerId,quoteRetry,reviewKey]);
  useEffect(()=>{if(mode!=="boarding"||!serviceLocation||!datesValid||selectedPets.length===0){queueMicrotask(()=>setBoardingQuote(null));return;}let active=true;const{scheduledStart,scheduledEnd}=stayCareWindow(start,end,startTime,endTime),packageCode=careWindow==="4 hours"?"boarding-4h":careWindow==="10 hours"?"boarding-10h":"boarding-24h";queueMicrotask(()=>{if(active){setBoardingQuote(null);setBoardingQuoteError("");}});void quoteBoarding({packageCode,petCount:selectedPets.length,cityId:serviceLocation.assignment.cityId,zoneId:serviceLocation.assignment.zoneId,scheduledStart:scheduledStart.toISOString(),scheduledEnd:scheduledEnd.toISOString(),paymentMode:splitEligible&&splitPayment?"split_50_50":"prepaid",providerId:selectedBoardingHost?.providerId}).then(value=>{if(active){setBoardingQuote(value);setBoardingQuotedKey(reviewKey);setBoardingQuoteError("");}}).catch(problem=>{if(active){setBoardingQuote(null);setBoardingQuoteError(problem instanceof Error?problem.message:"Unable to refresh Boarding quote");}});return()=>{active=false;};},[mode,serviceLocation,datesValid,careWindow,startTime,endTime,start,end,selectedPets.length,splitEligible,splitPayment,selectedBoardingHost?.providerId,quoteRetry,reviewKey]);
  useEffect(()=>{if(mode!=="boarding"||!serviceLocation||!datesValid||selectedPets.length===0){queueMicrotask(()=>setBoardingQuote(null));return;}let active=true;const controller=new AbortController(),queryKey=boardingHostQueryKey,{scheduledStart,scheduledEnd}=stayCareWindow(start,end,startTime,endTime);const settle=window.setTimeout(()=>void loadBoardingCommercial({cityId:serviceLocation.assignment.cityId,zoneId:serviceLocation.assignment.zoneId,scheduledStart:scheduledStart.toISOString(),scheduledEnd:scheduledEnd.toISOString(),petCount:selectedPets.length,species:selectedSpeciesKey?selectedSpeciesKey.split(","):[],requirements:boardingRequirements(selectedNeeds)},{signal:controller.signal}).then(data=>{if(!active)return;const hosts=data.hosts.map(toBoardingCaregiver);setBoardingHosts(hosts);setBoardingHostWindowKey(queryKey);setBoardingHostError("");setCaregiver(current=>hosts.find(host=>host.providerId===current.providerId)??hosts[0]??boardingPlaceholder);}).catch(problem=>{if(!active)return;setBoardingHosts([]);setBoardingHostWindowKey(queryKey);setBoardingHostError(problem instanceof Error?problem.message:"Unable to load Boarding host availability");setCaregiver(boardingPlaceholder);}),STAY_SEARCH_SETTLE_MS);return()=>{active=false;window.clearTimeout(settle);controller.abort();};},[mode,serviceLocation,datesValid,careWindow,startTime,endTime,start,end,selectedPets.length,boardingHostQueryKey,selectedSpeciesKey,hostRetry,selectedNeeds]);
  useEffect(()=>{
   if(mode!=="sitting"||!serviceLocation||!datesValid||!selectedPets.length)return;
   let active=true;const controller=new AbortController(),queryKey=boardingHostQueryKey,{scheduledStart,scheduledEnd}=stayCareWindow(start,end,startTime,endTime);
   const settle=window.setTimeout(()=>void previewSittersPatiently({clientRequestId:`preview:${queryKey}`,customerId:customer.customerId,petIds:selectedPets,serviceCode:"pet_sitting",serviceAddress:serviceLocation.address,servicePincode:serviceLocation.assignment.pincode,scheduledStart:scheduledStart.toISOString(),scheduledEnd:scheduledEnd.toISOString(),careMode:careWindow==="24 hours"?"overnight":"visit"},controller.signal).then(data=>{if(!active)return;const rows:Caregiver[]=data.providers.map(provider=>({...sitterPlaceholder,providerId:provider.id,name:provider.name,model:provider.model,initials:hostInitials(provider.name),area:serviceLocation.assignment.area,badge:"Available for this window",home:"Availability checked against the current schedule. Confirmation rechecks the slot.",availabilityVerified:true}));setSitters(rows);setSitterWindowKey(queryKey);setSitterError("");setCaregiver(current=>rows.find(row=>row.providerId===current.providerId)??rows[0]??sitterPlaceholder);}).catch(problem=>{if(active){setSitters([]);setSitterWindowKey(queryKey);setSitterError(isAvailabilityPending(problem)?SITTER_STILL_CHECKING:problem instanceof Error?problem.message:"Unable to load sitters");setCaregiver(sitterPlaceholder);}}),STAY_SEARCH_SETTLE_MS);return()=>{active=false;window.clearTimeout(settle);controller.abort();};
  },[mode,serviceLocation,datesValid,selectedPets,boardingHostQueryKey,customer.customerId,start,end,careWindow,startTime,endTime,hostRetry]);
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
  const resetStaySelection = () => {
    setBoardingHosts([]);
    setBoardingHostWindowKey("");
    setBoardingHostError("");
    setSitters([]);
    setSitterWindowKey("");
    setSitterError("");
    setBoardingQuote(null);
    setSittingQuote(null);
    setSittingQuoteError("");
    setBoardingQuoteError("");
    setScheduleError("");
  };
  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    onModeChange?.(next);
    resetStaySelection();
    setCaregiver(next === "boarding" ? boardingPlaceholder : sitterPlaceholder);
    setTaxi(false);
    setProfileOpen(true);
    setStage(1);
  };
  const confirm = async () => {
    if(actionLock.current)return;
    if (!datesValid || !agreed) return;
    if (selectedPets.length === 0) { setScheduleError("Select at least one pet to continue."); return; }
    if (!serviceLocation) { setScheduleError("Verify the service address before continuing."); return; }
    if (!activeQuote) { setScheduleError(quoteError || "Wait for the current stay price before confirming."); return; }
    if (mode === "boarding" && selectedPetObjs.some((pet) => pet.vaccinationStatus !== "verified")) { setScheduleError("Boarding requires verified vaccination for every selected pet."); return; }
    if(!careDraft.vet?.trim()||!careDraft.emergencyContact?.trim()||(mode==="sitting"&&!careDraft.homeAccess?.trim())){setScheduleError("Add vet and emergency contacts, plus home access for Sitting, in your Care Card before confirming.");return;}
    actionLock.current=true;setScheduling(true);setScheduleError("");
    const attemptKey=JSON.stringify([reviewKey,careDraft,selectedBenefits,foodType]);
    if(!bookingAttempt.current||bookingAttempt.current.key!==attemptKey)bookingAttempt.current={key:attemptKey,id:`stay:${crypto.randomUUID()}`};
    const attempt=bookingAttempt.current;
    try {
    if(mode==="sitting"&&!selectedSitter)throw new Error("Select a currently available sitter before confirming");
    const{scheduledStart:scheduleStart,scheduledEnd:scheduleEnd}=stayCareWindow(start,end,startTime,endTime),zoneId=serviceLocation.assignment.zoneId;
    const boardingCommercial=mode==="boarding"&&!attempt.host?await loadBoardingCommercial({cityId:serviceLocation.assignment.cityId,zoneId,scheduledStart:scheduleStart.toISOString(),scheduledEnd:scheduleEnd.toISOString(),petCount:selectedPets.length,species:selectedSpecies,requirements:boardingRequirements(selectedNeeds)}):null,governedHost=attempt.host??boardingCommercial?.hosts.find(item=>item.providerId===caregiver.providerId);if(mode==="boarding"&&!governedHost)throw new Error("Selected Boarding host is no longer available for this stay window");
    const packageCode=careWindow==="4 hours"?"boarding-4h":careWindow==="10 hours"?"boarding-10h":"boarding-24h",governedBoardingQuote=mode==="boarding"?(attempt.boarding??await quoteBoarding({packageCode,petCount:selectedPets.length,cityId:serviceLocation.assignment.cityId,zoneId,scheduledStart:scheduleStart.toISOString(),scheduledEnd:scheduleEnd.toISOString(),paymentMode:splitEligible&&splitPayment?"split_50_50":"prepaid",providerId:governedHost?.providerId})):null;
    const governedSittingQuote=mode==="sitting"?(attempt.sitting??await createSittingQuote({packageCode:careWindow==="24 hours"?"sitting-overnight":"sitting-visit-60",petCount:selectedPets.length,cityId:serviceLocation.assignment.cityId,zoneId,scheduledStart:scheduleStart.toISOString(),scheduledEnd:scheduleEnd.toISOString(),paymentMode:splitEligible&&splitPayment?"split_50_50":"prepaid",providerId:selectedSitter?.providerId})):null;
    const refreshed=governedBoardingQuote??governedSittingQuote!;
    if(!sameReviewedStayQuote(activeQuote,refreshed)){
      if(mode==="boarding"){setBoardingQuote(governedBoardingQuote);setBoardingQuotedKey(reviewKey);}else{setSittingQuote(governedSittingQuote);setSittingQuotedKey(reviewKey);}
      setAgreed(false);throw new Error("Your price or payment schedule changed. Review the updated amount before continuing, and check Activity for any earlier request.");
    }
    attempt.host=governedHost;attempt.boarding=governedBoardingQuote??undefined;attempt.sitting=governedSittingQuote??undefined;
    const requestId=attempt.id,decision=attempt.schedule??await reserveUatSchedule({clientRequestId:requestId,customerId:customer.customerId,petIds:selectedPets,serviceCode:mode==="boarding"?"boarding":"pet_sitting",serviceAddress:serviceLocation.address,servicePincode:serviceLocation.assignment.pincode,cityId:serviceLocation.assignment.cityId,zoneId,scheduledStart:scheduleStart.toISOString(),scheduledEnd:scheduleEnd.toISOString(),careMode:careWindow==="24 hours"?"overnight":"visit",preferredProviderId:mode==="boarding"?governedHost?.providerId:selectedSitter?.providerId});
    attempt.schedule=decision;
    const expectedProvider=mode==="boarding"?governedHost?.providerId:selectedSitter?.providerId;
    if(decision.provider.id!==expectedProvider)throw new Error("The selected caregiver changed. Check your existing request before trying a different caregiver.");
    let canonicalBookingId:string;
    if(mode==="sitting"){
      const quote=governedSittingQuote!;const result=await createCanonicalSittingBooking({idempotencyKey:`sitting:${quote.quoteId}:${customer.customerId}`,groupId:decision.groupId,sittingQuoteId:quote.quoteId,customer:{id:customer.customerId,name:customer.customerName,primaryPhone:customer.phone},pets:selectedPetObjs.map(p=>({sourceId:p.sourceId??p.id,name:p.name,species:p.species==="cat"?"cat":p.species==="dog"?"dog":"other",breed:p.breed??undefined,vaccinationStatus:p.vaccinationStatus})),cityId:serviceLocation.assignment.cityId,zoneId,packageCode:quote.packageCode,packageName:quote.packageName,scheduledStart:quote.scheduledStart,scheduledEnd:quote.scheduledEnd,provider:decision.provider,totalAmount:quote.totalAmount,amountDueNow:quote.amountDueNow,payment:{method:"payment_link",mode:quote.paymentMode,detail:"Awaiting verified Razorpay payment"},meetGreetRequestId:currentMeeting?.id});canonicalBookingId=result.bookingId;
    }else{
      const quote=governedBoardingQuote!;const result=await createCanonicalLifecycle({idempotencyKey:requestId,scheduleGroupId:decision.groupId,customer:{id:customer.customerId,name:customer.customerName,primaryPhone:customer.phone},pets:selectedPetObjs.map(p=>({sourceId:p.sourceId??p.id,name:p.name,species:p.species==="cat"?"cat":p.species==="dog"?"dog":"other" as const,breed:p.breed??undefined,vaccinationStatus:p.vaccinationStatus,medicationRequired:selectedNeeds.includes("Medication")})),cityId:serviceLocation.assignment.cityId,zoneId,serviceCode:"boarding",packageCode:quote.packageCode,packageName:quote.packageName,scheduledStart:scheduleStart.toISOString(),scheduledEnd:scheduleEnd.toISOString(),provider:decision.provider,totalAmount:quote.totalAmount,amountDueNow:quote.amountDueNow,payment:{method:"upi",mode:quote.paymentMode,status:"created",detail:"Awaiting verified Razorpay payment"},pricing:{discount:0,boardingQuoteId:quote.quoteId,boardingRequirements:boardingRequirements(selectedNeeds)}});canonicalBookingId=result.bookingId;
    }
    const plan=mode==="boarding"?boardingCareDraft(careDraft,selectedNeeds,selectedBenefits,foodType):{...careDraft,specialInstructions:[careDraft.specialInstructions,selectedNeeds.length?`Care requests: ${selectedNeeds.join(', ')}`:''].filter(Boolean).join('\n')};setConfirmedCarePlan(plan);
    // Care saving has its own retry boundary; canonical creation is not payment confirmation.
    setConfirmedTotal(governedBoardingQuote?.totalAmount ?? governedSittingQuote?.totalAmount ?? total);
    setBookingId(canonicalBookingId);
    rememberBookingReference(canonicalBookingId);
    const paymentQuote=governedBoardingQuote??governedSittingQuote!;setPendingPayment({bookingId:canonicalBookingId,serviceName:mode==="boarding"?"Boarding":"Pet Sitting",total:paymentQuote.totalAmount,dueNow:paymentQuote.amountDueNow,mode:paymentQuote.paymentMode});
    } catch(error){setScheduleError(error instanceof Error?error.message:"No host or sitter is available for the full care window");} finally {actionLock.current=false;setScheduling(false);}

  };
  if(pendingPayment)return <StayCarePaymentGate key={pendingPayment.bookingId} routeScope={routeScope} mode={mode} carePlan={confirmedCarePlan??careDraft} payment={pendingPayment} onVerified={()=>{setCareSaveError("");setPendingPayment(null);setConfirmed(true);}}/>;
  if(recoveryBookingId)return <BookingReferenceRecovery bookingId={recoveryBookingId} service={mode} routeScope={routeScope} className={styles.flow}/>;
  if (confirmed)
    return (
      <>
        {toast && <div className={styles.toast}>{toast}</div>}
        <LiveStay
          routeScope={routeScope}
          bookingId={bookingId}
          initialCarePlan={confirmedCarePlan}
          initialError={careSaveError}
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
      {stage > 1 && quoteError && <div role="alert"><p>{quoteError}</p><button type="button" onClick={() => setQuoteRetry(value => value + 1)}>Retry price</button></div>}
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
              type="button"
              aria-pressed={mode === "boarding"}
              className={mode === "boarding" ? styles.selected : ""}
              onClick={() => switchMode("boarding")}
            >
              <i>⌂</i>
              <b>Home Boarding</b>
              <span>Pets stay in a verified host home</span>
            </button>
            <button
              type="button"
              aria-pressed={mode === "sitting"}
              className={mode === "sitting" ? styles.selected : ""}
              onClick={() => switchMode("sitting")}
            >
              <i>♡</i>
              <b>Pet Sitting</b>
              <span>A sitter cares for pets at your home</span>
            </button>
          </div>
          <StayAddress customerId={customer.customerId} mode={mode} onResolved={setServiceLocation}/>
          {mode === "sitting" && <div className={styles.modeSwitch} role="group" aria-label="Pet Sitting care">
            <button type="button" aria-pressed={visitMode} className={visitMode ? styles.selected : ""} onClick={() => {setSittingCare("visit");resetStaySelection();}}><i>◷</i><b>Home Visit</b><span>One 60-minute visit</span></button>
            <button type="button" aria-pressed={!visitMode} className={!visitMode ? styles.selected : ""} onClick={() => {setSittingCare("overnight");resetStaySelection();}}><i>☾</i><b>Overnight Pet Sitting</b><span>More than 10 hours, priced per night</span></button>
          </div>}
          <div className={styles.datePair}>
            {visitMode ? <fieldset className={styles.careDate}><legend>Home Visit</legend>
              <label className={styles.field}>Visit date<input type="date" value={start} onChange={e=>{setStart(e.target.value);resetStaySelection();}}/></label>
              <label className={styles.field}>Visit start time<input type="time" value={startTime} onChange={e=>{setStartTime(e.target.value);resetStaySelection();}}/></label>
              <p className={styles.hint}>{visitEnd ? `60 minutes, ending ${visitEnd.time} IST.` : "60 minutes from the start time."} Need more care that day? Book another visit after this one.</p>
            </fieldset> : <>
            <fieldset className={styles.careDate}><legend>Check-in</legend>
              <label className={styles.field}>Check-in date<input type="date" value={start} onChange={e=>{setStart(e.target.value);resetStaySelection();}}/></label>
              <label className={styles.field}>Check-in time<input type="time" value={startTime} onChange={e=>{setStartTime(e.target.value);resetStaySelection();}}/></label>
            </fieldset>
            <fieldset className={styles.careDate}><legend>Check-out</legend>
              <label className={styles.field}>Check-out date<input type="date" value={end} min={start} onChange={e=>{setEnd(e.target.value);resetStaySelection();}}/></label>
              <label className={styles.field}>Check-out time<input type="time" value={endTime} onChange={e=>{setEndTime(e.target.value);resetStaySelection();}}/></label>
            </fieldset></>}
          </div>
          <p className={styles.durationSummary} role={datesValid?"status":"alert"}>{overnightTooShort ? "Overnight Pet Sitting covers more than 10 hours. For shorter care, choose a 60-minute Home Visit." : stayWindow.summary}</p>
          <p className={styles.hint}>All care times are in India Standard Time (IST). Pricing updates for the full selected stay.</p>
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
                type="button"
                key={p.id}
                aria-pressed={selectedPets.includes(p.id)}
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
            <button type="button" className={styles.addPet} onClick={() => setShowPetManager(v => !v)}>
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
                type="button"
                key={n}
                aria-pressed={selectedNeeds.includes(n)}
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
                ? `${stayWindow.duration} selected · We’ll show hosts available for your dates and location.`
                : "We’ll show sitters available for your dates and location."
              : "End date must be after the start date."}
          </p>
          <button
            type="button"
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
          {mode === "boarding" && !serviceLocation && <p role="alert">Return to Plan and verify a service address before searching for hosts.</p>}
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
                    {mode === "boarding" ? `Host location · ${c.area}` : `📍 ${c.area} · availability checked`}
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
                    {mode === "boarding" ? `${c.availableGuestPets ?? 0} guest-pet spots available` : "No synthetic customer reviews shown"}
                  </span>
                  <strong>
                    {activeQuote ? money(activeQuote.basePricePerPet) : quoteError ? "Price unavailable" : "Calculating price…"}
                    {activeQuote && <small>{mode === "boarding" ? " / pet / stay unit" : sittingQuote?.mode==="overnight"?" / night":" / visit"}</small>}
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
                {mode === "boarding" ? "Identity, species eligibility and stay capacity come from PawSpace governed records. Published profile details are loaded below. Private messages and your service feedback are linked to the saved booking." : "Availability comes from the current schedule. Published profile details appear below; private chat opens from a confirmed booking."}
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
            mode === "boarding" ? <article className={styles.secureChat}><header><b>Boarding chat</b><span>UAT boundary</span></header><p>Before booking, request a separate introduction on the Care Card. Private chat is linked to the confirmed stay.</p></article> : <article className={styles.secureChat}><header><b>Sitter chat</b></header><p>Before booking, request a separate introduction on the Care Card. Private chat is linked to the confirmed Sitting booking.</p></article>
          )}
          {showCaregiver && profileOpen && (
            <CaregiverPublicProfile key={caregiver.providerId} providerId={caregiver.providerId!}/>
          )}
          <button className={styles.back} onClick={() => setStage(1)}>
            ← Plan
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
                  ? "Your care instructions are saved against this booking."
                  : "Share the access instructions your assigned care team should use."}
              </span>
            </div>
          </article>
          <div className={styles.careInstructions}><p>Enter the instructions your caregiver should follow. These will be saved with the booking. Requests and extras require caregiver agreement.</p>{([['feeding','Food and water routine'],['medication','Medication and allergy instructions from your vet'],['vet','Vet contact'],['emergencyContact','Emergency contact'],['homeAccess','Home access instructions'],['specialInstructions','Other care instructions']] as const).filter(([field])=>mode==="sitting"||field!=="homeAccess").map(([field,title])=><label className={styles.field} key={field}>{title}<textarea value={careDraft[field]||""} required={['vet','emergencyContact','homeAccess'].includes(field)} onChange={event=>setCareDraft(value=>({...value,[field]:event.target.value}))}/></label>)}</div>
          {mode==="boarding"&&<><div className={styles.sectionHead}><b>Requested extras</b><span>Subject to host agreement</span></div><div className={styles.benefitGrid}>{careBenefits.map(benefit=><button key={benefit} className={selectedBenefits.includes(benefit)?styles.selected:""} onClick={()=>toggleBenefit(benefit)}>{selectedBenefits.includes(benefit)?"✓":"＋"} {benefit}</button>)}</div><label className={styles.field}>Food preference<select value={foodType} onChange={event=>setFoodType(event.target.value)}><option value="">Choose a preference</option><option>Pet food from home</option><option>Vegetarian fresh food</option><option>Non-vegetarian fresh food</option><option>Host to quote food separately</option></select></label></>}
          {caregiver.providerId&&<StayMeetingRequest key={`${mode}:${caregiver.providerId}:${start}:${end}`} providerId={caregiver.providerId} providerName={caregiver.name} serviceCode={mode==="boarding"?"boarding":"pet_sitting"} start={start} end={end} onRequested={setMeeting}/>}
          <p className={styles.hint}>Care updates appear against the saved booking. Introduction requests are separate and never silently added to this stay bill.</p>
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
          <Head title="Review and confirm" note="Review · 4 of 4" />
          <article className={styles.review} aria-label="Review stay details">
            <span>
              Service
              <b>
                {mode === "boarding"
                  ? "Home Boarding"
                  : careWindow === "24 hours" ? "Overnight Pet Sitting" : "Home Visit · 60 minutes"}
              </b>
            </span>
            <span>
              Pets<b>{selectedPetNames.join(" + ")}</b>
            </span>
            <span>
              Dates
              <b>
                {stayWindow.summary}
              </b>
            </span>
            <span>
              Caregiver
              <b>
                {caregiver.name}{mode === "boarding" ? ` · ${caregiver.rating} ★` : ""} · {mode === "boarding" ? `${caregiver.model === "full_time" ? "full-time" : "commission"} host` : "commission partner"}
              </b>
            </span>
            <span>Service address<b>{serviceLocation?.address||"Verify your saved address"}</b></span>
            <span>
              Partner approval<b>{mode === "boarding" ? "Host acceptance follows the canonical booking request" : "Final assignment and partner approval are requested at confirmation"}</b>
            </span>
            <span>
              Care benefits<b>{selectedBenefits.join(" · ")}</b>
            </span>
            <span>
              Food<b>{foodType||"See care instructions"}</b>
            </span>
            <span>Separate introduction<b>{currentMeeting?`${currentMeeting.id} · ${currentMeeting.status} · quoted fee ${money(currentMeeting.priceCharged)}; no collection claimed`:"Not requested"}</b></span>
            <span>
              Booking updates<b>View recorded care and requests in Activity</b>
            </span>
          </article>
          {mode==="sitting"&&sittingQuote?.mode==="visit"&&<p>A Home Visit is one 60-minute visit at the published price for your pets. Need more care that day? Book another visit after this one.</p>}
          <div className={styles.bill}>
            <span>
              {caregiver.name} · {stayWindow.duration}<b>{quoteMoney(base)}</b>
            </span>
            {extraPets > 0 && (
              <span>
                {extraPets} additional {extraPets === 1 ? "pet" : "pets"}
                <b>{quoteMoney(extra)}</b>
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
            {currentMeeting&&<p>Introduction {currentMeeting.id} is a separate request and is excluded from this stay total.</p>}
            <strong>
              Booking total<b>{quoteMoney(total)}</b>
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
                    {quoteMoney(Math.round(total*50)/100)} now · {quoteMoney(Math.round((total-Math.round(total*50)/100)*100)/100)} due 24
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
                  <small>{quoteMoney(total)} · no later balance</small>
                </span>
              </button>

            </section>
          ) : (
            <article className={styles.fullPaymentNote}>
              <i>₹</i>
              <div>
                <b>{mode === "boarding" ? "Full prepaid UAT payment from the canonical Boarding quote" : "Full payment for a Home Visit or stays up to 4 nights"}</b>
                <span>
                  {"50/50 split payment becomes available automatically for overnight stays longer than four nights."}
                </span>
              </div>
            </article>
          )}
          <p className={styles.hint}>{mode === "boarding" ? "Boarding" : "Pet Sitting"} coupons are disabled until that service has an explicit canonical redemption policy.</p>
          <article className={styles.protection}>
            <i>✓</i>
            <div>
              <b>PawSpace Stay Protection</b>
              <span>{mode === "boarding" ? "Host capacity is rechecked when requested. Payment is not yet verified. Cancellation/refund policy, live messaging and 24/7 support integrations remain pre-live gates." : "The canonical quote is ready. Sitter capacity is confirmed only when the scheduler accepts this request; payment remains UAT sandbox-only."}</span>
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
            {mode === "boarding" ? "Production OTP is not connected; this UAT checkout uses a sandbox payment." : "This checkout uses your signed-in customer account and a sandbox payment."} {activeQuote && `${money(reserveAmount)} will be collected in this test checkout.`} {!activeQuote ? "The payment schedule will appear when pricing is ready." : balanceAmount > 0
              ? `${quoteMoney(balanceAmount)} is due 24 hours before the booking starts.`
              : "No later balance remains."}
          </p>
          <button className={styles.back} disabled={scheduling} onClick={() => setStage(3)}>
            ← Care plan
          </button>
          <button
            disabled={!agreed || !datesValid || scheduling || selectedPets.length === 0 || !serviceLocation || !activeQuote}
            className={styles.primary}
            onClick={confirm}
          >
            {scheduling ? "Locking care capacity…" : !activeQuote ? (quoteError ? "Price unavailable" : "Calculating price…") : mode === "boarding" ? "Create stay request & review payment" : "Request sitter & review payment"}
          </button>
          {scheduleError && <p role="alert">{scheduleError}</p>}
        </>
      )}
    </section>
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
function LiveStay({bookingId,mode,caregiver,view,setView,initialCarePlan,initialError,routeScope="legacy"}:{routeScope?:"legacy"|"v2";bookingId:string;initialCarePlan?:SittingCarePlan;initialError?:string;start:string;end:string;nights:number;mode:Mode;caregiver:Caregiver;pets:string[];total:number;taxi:boolean;view:View;setView:(value:View)=>void;flash:(message:string)=>void}){
 if(mode === "sitting")return <SittingCustomerPanel key={bookingId} bookingId={bookingId} initialCarePlan={initialCarePlan} initialError={initialError} />;
 return <section className={styles.flow}><h2>Boarding booking · {bookingId}</h2><Link href={`${routeScope==="v2"?"/v2":""}/boarding/manage?bookingId=${encodeURIComponent(bookingId)}`}>Open saved booking and care</Link><Link href={routeScope==="v2"?`/v2/taxi?sourceBookingId=${encodeURIComponent(bookingId)}`:`/mobile-app?service=pet_taxi&sourceBookingId=${encodeURIComponent(bookingId)}`}>Add Pet Taxi for this Boarding stay →</Link><nav aria-label="Boarding booking sections" className={styles.liveTabs}><button onClick={()=>setView("stay")}>Stay status</button><button onClick={()=>setView("care")}>Care and requests</button></nav>{view === "stay"?<BoardingCustomerStayStatus bookingId={bookingId} caregiverName={caregiver.name}/>:<BoardingCustomerStayPanel routeScope={routeScope} bookingId={bookingId} caregiverName={caregiver.name} initialCarePlan={initialCarePlan} initialError={initialError}/>}</section>;
}
