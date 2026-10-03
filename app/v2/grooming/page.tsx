"use client";
import {subscriptionPackage,subscriptionSavings} from "../../../lib/v2/grooming-subscription-projection";
/* eslint-disable @next/next/no-img-element, react-hooks/set-state-in-effect */

import Link from "next/link";
import GroomingVerifiedAddressPicker from "./verified-address-picker";
import GroomingCustomerIntake from "./customer-intake";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { couponNeedsReapply } from "../../../lib/coupon-reapply-guard";
import type { CustomerAccountRecord } from "../../../lib/customer-account";
import { groomingBookingDates, groomingSlotAvailable, groomingSlotWindow } from "../../../lib/grooming-booking-calendar";
import {
  loadV2CustomerAccount,
  loadV2CustomerSession,
  loadV2ServiceAvailability,
} from "../../../lib/v2/customer-experience-client";
import {
  groomingBundleForCount,
  loadV2GroomingCatalogue,
  previewV2Groomers,
  quoteV2Grooming,
  resolveV2GroomingCoverage,
  type V2GroomingCatalogue,
  type V2GroomingPackage,
  type V2GroomingQuote,
} from "../../../lib/v2/grooming-client";
import type { ResolvedServiceCoverage } from "../../../lib/service-zone-client";
import type { ProviderPreview } from "../../../lib/uat-scheduling-client";
import {
  createV2GroomingBooking,
  type V2GroomingBooking,
  type V2GroomingPaymentChoice,
} from "../../../lib/v2/grooming-checkout-client";
import { useQueryParameter } from "../../../lib/use-query-parameter";
import GroomingGuestPreview from "./guest-preview";
import V2GroomingPaymentPanel from "./payment-panel";
import V2GroomingCouponBox, { type V2CouponIntent } from "./coupon-box";
import ContactForm from "../../contact/contact-form";
import { serviceAddressConflict } from "../../../lib/service-address-consistency";
import { EXTRA_CARE_MINUTES, v2ExtraCareReason, v2GroomingPetAudience, v2GroomingSelectionIssue, v2YoungPackageIssue } from "../../../lib/v2/grooming-selection";
import styles from "./grooming.module.css";
import {formatIndiaRange} from "../../../lib/india-time";
import {serviceAddressText} from "../../../lib/service-address-text";
import PetManager from "../pet-form";
import { groomingAddOnsForSpecies } from "../../../lib/grooming-add-ons";
import { groomingCommercialPackages } from "../../../lib/grooming-commercial-catalogue";
import { groomingBasketTotal } from "../../../lib/v2/grooming-money";
import { groomingTestCoinQuote } from "../../../lib/v2/grooming-test-coin-quote";
import TestCoinServicePreview from "../test-coin-service-preview";
import GroomingLocationAssist from "./location-assist";
import { GROOMING_STEPS, groomingStepAccess, suggestedGroomerId, type GroomingStep } from "../../../lib/v2/grooming-navigation";

const SLOT_LABELS = ["9:00 – 11:00 AM", "11:00 AM – 1:00 PM", "1:00 – 3:00 PM", "3:00 – 5:00 PM", "5:00 – 7:00 PM"];
const AUDIENCE_LABEL: Record<V2GroomingPackage["audience"], string> = { dog: "Dogs", cat: "Cats", young: "Puppies & kittens" };
const money = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);

export default function V2GroomingPage() {
  const recoveryBookingId = useQueryParameter("bookingId");
  const [guest, setGuest] = useState(false);
  const [account, setAccount] = useState<CustomerAccountRecord | null>(null);
  const [catalogue, setCatalogue] = useState<V2GroomingCatalogue | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeStep, setActiveStep] = useState<GroomingStep>(1);
  const [fatal, setFatal] = useState("");
  const [selectedPetIds, setSelectedPetIds] = useState<string[]>([]);
  // New customers used to reach a dead end here: pets could only be added in V2 Account.
  const [addingPet, setAddingPet] = useState(false);
  // Owner decision (H4): the in-app extras, in V2 before launch.
  const [addOns, setAddOns] = useState<string[]>([]);
  const [comfort, setComfort] = useState<"friendly" | "anxious" | "aggressive">("friendly");
  const [specialInstructions, setSpecialInstructions] = useState("");
  const [largeHousehold, setLargeHousehold] = useState<string[] | null>(null);
  const [guestPackageCode, setGuestPackageCode] = useState(() => {try{return recoveryBookingId?"":window.sessionStorage.getItem("pawspace_v2_grooming_guest_package")||"";}catch{return "";}});
  const [selectedPackageCode, setSelectedPackageCode] = useState(guestPackageCode);
  const [address, setAddress] = useState("");
  const [savedAddressId, setSavedAddressId] = useState("");
  // A typed doorstep is kept in the account only when the customer asks; availability checks never save it.
  const [saveAddress, setSaveAddress] = useState(false);
  const [pincode, setPincode] = useState("");
  const [coverage, setCoverage] = useState<ResolvedServiceCoverage | null>(null);
  const [coverageBusy, setCoverageBusy] = useState(false);
  const [coverageError, setCoverageError] = useState("");
  const [locationPending, setLocationPending] = useState(false);
  const locationPendingRef = useRef(false), addressInputRef = useRef<HTMLInputElement>(null);
  const [locationRevision, setLocationRevision] = useState(0);
  const onLocationPendingChange = useCallback((pending: boolean) => {
    locationPendingRef.current = pending; setLocationPending(pending);
  }, []);
  const [date, setDate] = useState("");
  const [slotIndex, setSlotIndex] = useState(1);
  const [quote, setQuote] = useState<V2GroomingQuote | null>(null);
  const [scheduledStart, setScheduledStart] = useState("");
  const [scheduledEnd, setScheduledEnd] = useState("");
  const [providers, setProviders] = useState<ProviderPreview | null>(null);
  const [providerBusy, setProviderBusy] = useState(false);
  const [providerError, setProviderError] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [providerSelection, setProviderSelection] = useState<"auto" | "specific">("auto");
  const [paymentMode, setPaymentMode] = useState<V2GroomingPaymentChoice>("prepaid");
  const [booking, setBooking] = useState<V2GroomingBooking | null>(null);
  const [checkoutError, setCheckoutError] = useState("");
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  // A governed coupon quote for this exact live price; the server decides the discount and re-checks it at booking.
  const [coupon, setCoupon] = useState({ discount: 0, code: "", quoteId: "" });
  const couponIntentRef = useRef<V2CouponIntent>({ customerId: "", mode: "automatic", code: "" });
  const [couponCheckedKey, setCouponCheckedKey] = useState("");
  const onCouponChange = useCallback((discount: number, code: string, quoteId?: string) => setCoupon({ discount, code, quoteId: quoteId || "" }), []);
  const checkoutLock = useRef(false), mounted = useRef(true);
  const coverageVersion = useRef(0), careVersion = useRef(0);
  // Each (address, PIN) pair verifies itself once; a failed check waits for the customer, never loops.
  const autoCoverageKey = useRef("");
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const bootstrap = useCallback(async () => {
    setLoading(true);
    setFatal("");
    try {
      const [session, availability, nextCatalogue] = await Promise.all([
        loadV2CustomerSession(),
        loadV2ServiceAvailability(),
        loadV2GroomingCatalogue({cityId:"blr"}),
      ]);
      const grooming = availability.find(service => service.code === "grooming");
      if (!grooming?.enabled) throw new Error("Grooming is not accepting bookings in your area right now.");
      setCatalogue(nextCatalogue);
      setGuest(!session);
      if (!session) return;
      const nextAccount = await loadV2CustomerAccount();
      setAccount(nextAccount);
      const saved=nextAccount.addresses.find(item=>item.isDefault)||nextAccount.addresses[0];
      if(saved){setAddress(serviceAddressText({...saved,postalCode:undefined}));setPincode(saved.postalCode||"");setSavedAddressId(saved.id);}
      setCatalogue(nextCatalogue);
      if (nextAccount.pets[0]) setSelectedPetIds([nextAccount.pets[0].id]);
      const dates = groomingBookingDates(Date.now(), 14);
      setDate((dates[1] || dates[0])?.isoDate || "");
    } catch (problem) {
      setFatal(problem instanceof Error ? problem.message : "We could not start your grooming booking.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (!recoveryBookingId) void bootstrap(); }, [bootstrap, recoveryBookingId]);

  const selectedPets = useMemo(
    () => (account?.pets || []).filter(pet => selectedPetIds.includes(pet.id)),
    [account, selectedPetIds],
  );
  const audience = selectedPets[0] ? v2GroomingPetAudience(selectedPets[0], date || undefined) : null;
  const selectionIssue = v2GroomingSelectionIssue(selectedPets, undefined, date || undefined);
  const mixedAudience = Boolean(selectionIssue);
  const subscriptionPackages = useMemo(() => (catalogue?.subscriptions||[]).flatMap(plan=>{const care=catalogue?.packages.find(pkg=>pkg.code===plan.servicePackageCode);return care?plan.eligiblePetTypes.flatMap(species=>{const audience=species==="cat"?"cat":species==="dog"?"dog":null;const pkg=audience?subscriptionPackage(plan,care,audience):null;return pkg?[pkg]:[];}):[];}),[catalogue]);
  const packages = useMemo(
    () => [...(catalogue?.packages || []),...subscriptionPackages].filter(pkg => pkg.audience === audience && Boolean(groomingBundleForCount(pkg, selectedPets.length))),
    [catalogue, subscriptionPackages, audience, selectedPets.length],
  );
  useEffect(()=>{if(!coverage?.cityId||!date)return;let active=true;void loadV2GroomingCatalogue({cityId:coverage.cityId,zoneId:coverage.zoneId,date}).then(next=>{if(active)setCatalogue(next);}).catch(()=>{/* Workbook row 6: a failed zone reload used to wipe the published subscription plans from the grid; the city catalogue already shown stays. */});return()=>{active=false;};},[coverage?.cityId,coverage?.zoneId,date]);
  const selectedPackage = packages.find(pkg => pkg.code === selectedPackageCode) || (guestPackageCode && selectedPackageCode === guestPackageCode ? null : packages[0]) || null;
  const packageBundle = selectedPackage ? groomingBundleForCount(selectedPackage, selectedPets.length) : null;
  // Same package and price with a longer slot, so availability, the quote window, the groomer check and checkout agree.
  const extraCare = v2ExtraCareReason(selectedPets);
  const bundle = useMemo(() => packageBundle && extraCare ? { ...packageBundle, slotMinutes: packageBundle.slotMinutes + EXTRA_CARE_MINUTES, blockingMinutes: packageBundle.blockingMinutes + EXTRA_CARE_MINUTES } : packageBundle, [packageBundle, extraCare]);
  const youngIssue = selectedPackage?.audience === "young" && date && !mixedAudience ? v2YoungPackageIssue(selectedPets, date) : null;
  // Disabled checkout buttons point at the step that explains why.
  const blockingIssue = mixedAudience ? { id: "v2-selection-issue", step: "01" } : youngIssue ? { id: "v2-young-issue", step: "02" } : null;
  const availableAddOns = groomingAddOnsForSpecies(String(selectedPets[0]?.species || "").toLowerCase());
  const chosenAddOns = addOns.filter(label => availableAddOns.some(item => item.label === label));
  const addOnTotal = chosenAddOns.reduce((sum, label) => sum + (availableAddOns.find(item => item.label === label)?.price ?? 0), 0);
  const basketTotal = quote ? groomingBasketTotal(quote.price, addOnTotal) : null;
  const couponContextKey = JSON.stringify([account?.customerId, basketTotal, bundle?.packageCode, scheduledStart, coverage?.cityId, coverage?.zoneId, paymentMode]);
  const couponChecking = Boolean(quote && couponCheckedKey !== couponContextKey);
  const coinQuote = groomingTestCoinQuote({ basketTotal, quoteReady: Boolean(quote) && !providerBusy, couponChecking, coupon, paymentMode });
  // The amount payment review will charge: a server-checked coupon for THIS basket, not one still being checked or stale.
  const couponApplied = Boolean(quote && coupon.quoteId && !couponChecking && !couponNeedsReapply(coupon.code, coupon.quoteId));
  const summaryWhen=useMemo(()=>{if(!date||!bundle)return "Choose a date and package";try{const window=groomingSlotWindow(date,slotIndex,bundle.slotMinutes);return formatIndiaRange(scheduledStart||window.start,scheduledEnd||window.end);}catch{return "Choose a time that fits the full service duration";}},[date,slotIndex,bundle,scheduledStart,scheduledEnd]);
  const [dates] = useState(() => groomingBookingDates(Date.now(), 14));
  const stepAccess = groomingStepAccess({ petCount: selectedPets.length, selectionIssue: mixedAudience,
    hasPackage: Boolean(selectedPackage && bundle), packageIssue: Boolean(youngIssue),
    addressVerified: Boolean(coverage), reserving: checkoutBusy });
  const navigateToStep = (step: typeof GROOMING_STEPS[number]) => {
    if (checkoutLock.current || stepAccess[step.number]) return;
    const target = document.getElementById(step.id);
    if (!target) return;
    setActiveStep(step.number);
    target.focus({ preventScroll: true });
    target.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  };


  useEffect(() => {
    if (selectedPackage && selectedPackage.code !== selectedPackageCode) setSelectedPackageCode(selectedPackage.code);
  }, [selectedPackage, selectedPackageCode]);
  const previousStep = GROOMING_STEPS.find(step => step.number === activeStep - 1), currentStep = GROOMING_STEPS.find(step => step.number === activeStep);
  // Published inclusions and exclusions for the selected package (a subscription reads its care package); nothing is invented.
  const packageTruth = selectedPackage ? groomingCommercialPackages.find(item => item.code === (selectedPackage.subscription?.servicePackageCode || selectedPackage.code)) || null : null;
  // Early serviceability (workbook Grooming rows 1 and 7): the saved, default or typed address verifies itself as soon as
  // its house line and six-digit PIN are present, once per address, so a mismatch surfaces here and not at payment.
  // The address identity, PIN validation and the server-side doorstep verification at booking are unchanged.
  useEffect(() => {
    const key = JSON.stringify([address.trim(), pincode]);
    if (pincode.length !== 6 || address.trim().length < 8 || coverage || coverageBusy || locationPending || checkoutBusy || autoCoverageKey.current === key) return;
    autoCoverageKey.current = key;
    const timer = setTimeout(() => { void verifyCoverage(); }, 350);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, pincode, coverage, coverageBusy, locationPending, checkoutBusy]);
  // Once the live price and groomers are confirmed, the next step is the payment review in the summary.
  useEffect(() => {
    if (!quote || !providers?.providers.length) return;
    document.getElementById("v2-grooming-summary")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  }, [quote, providers]);

  const invalidateCare = () => {
    careVersion.current++;
    setProviderBusy(false);
    setScheduledStart(""); setScheduledEnd("");
    setQuote(null); setCouponCheckedKey(""); setCoupon({ discount: 0, code: "", quoteId: "" });
    setProviders(null);
    if (providerSelection === "auto") setSelectedProviderId("");
    setProviderError("");
  };
  useEffect(() => { invalidateCare(); }, [selectedPetIds, selectedPackageCode, coverage?.zoneId, date, slotIndex]);
  const invalidateDoorstep = () => {
    coverageVersion.current++; setCoverageBusy(false); setCoverage(null); invalidateCare();
  };

  useEffect(() => { if (largeHousehold) document.getElementById("v2-large-family-enquiry")?.focus(); }, [largeHousehold]);
  const togglePet = (id: string) => {
    if (!selectedPetIds.includes(id) && selectedPetIds.length >= 4) {
      setLargeHousehold((account?.pets || []).filter(pet => [...selectedPetIds, id].includes(pet.id)).map(pet => pet.name));
      return;
    }
    invalidateCare();
    setSelectedPetIds(current => {
      if (current.includes(id)) return current.length === 1 ? current : current.filter(item => item !== id);
      if (current.length >= 4) return current;
      return [...current, id];
    });
  };

  const editServiceAddress = () => {
    if (checkoutLock.current) return;
    invalidateDoorstep(); setCoverageError(""); setSavedAddressId(""); setSaveAddress(false);
    setLocationRevision(value => value + 1); addressInputRef.current?.focus();
  };

  async function verifyCoverage() {
    if (checkoutLock.current || locationPendingRef.current) return;
    const version = ++coverageVersion.current;
    invalidateCare();
    setCoverageBusy(true);
    setCoverageError("");
    setCoverage(null);
    try {
      if (address.trim().length < 8) throw new Error("Add your house, street and area before verifying serviceability.");
      const result = await resolveV2GroomingCoverage(pincode);
      const conflict = serviceAddressConflict(address, result.city, result.pincode);
      if (conflict) throw new Error(conflict);
      if (mounted.current && version === coverageVersion.current) setCoverage(result);
    } catch (problem) {
      if (mounted.current && version === coverageVersion.current) setCoverageError(problem instanceof Error ? problem.message : "We could not verify this service address.");
    } finally {
      if (mounted.current && version === coverageVersion.current) setCoverageBusy(false);
    }
  }

  const beginSecureCheckout = async () => {
    if (checkoutLock.current || providerBusy || mixedAudience || youngIssue || couponChecking || couponNeedsReapply(coupon.code, coupon.quoteId) || locationPendingRef.current) return;
    const provider = providerSelection === "auto" ? providers?.providers[0] : providers?.providers.find(item => item.id === selectedProviderId);
    if (!account || !selectedPackage || !bundle || !quote || !coverage || !provider || !scheduledStart || !scheduledEnd) return;
    checkoutLock.current = true; setCheckoutBusy(true); setCheckoutError("");
    try {
      await createV2GroomingBooking({
        account, selectedPets, pkg: selectedPackage, bundle, quote, provider, providerSelection, paymentMode,
        address, pincode: coverage.pincode, cityName: coverage.city, cityId: coverage.cityId, zoneId: coverage.zoneId,
        scheduledStart, scheduledEnd, saveAddress: saveAddress && !savedAddressId,
        addOns: addOns.filter(label => availableAddOns.some(item => item.label === label)), comfort, specialInstructions,
        coupon: coupon.quoteId ? { quoteId: coupon.quoteId, code: coupon.code, discount: coupon.discount } : undefined,
      }, current => {
        if (!mounted.current) return;
        setBooking(current);
        const url = new URL(window.location.href);
        url.searchParams.set("bookingId", current.bookingId);
        window.history.replaceState(window.history.state, "", url.pathname + url.search);
      });
    } catch (problem) {
      if (mounted.current) setCheckoutError(problem instanceof Error ? problem.message : "We could not prepare checkout.");
    } finally { checkoutLock.current = false; if (mounted.current) setCheckoutBusy(false); }
  };

  const checkLiveCare = async () => {
    if (checkoutLock.current || locationPendingRef.current) return;
    if (!account || !bundle || !coverage || !date || mixedAudience || youngIssue) return;
    const version = ++careVersion.current;
    setQuote(null); setCouponCheckedKey(""); setCoupon({ discount: 0, code: "", quoteId: "" });
    setProviderBusy(true);
    setProviderError("");
    setProviders(null);
    if (providerSelection === "auto") setSelectedProviderId("");
    try {
      if (!groomingSlotAvailable(date, slotIndex, bundle.slotMinutes)) throw new Error("That grooming slot can no longer be booked. Pick another time.");
      const priced = await quoteV2Grooming({ bundle, subscription:selectedPackage?.subscription, isoDate: date, slotIndex, cityId: coverage.cityId, zoneId: coverage.zoneId });
      if (!mounted.current || version !== careVersion.current) return;
      const preview = await previewV2Groomers({
        customerId: account.customerId,
        serviceAddress: address,
        servicePincode: coverage.pincode,
        petIds: selectedPets.map(pet => pet.id),
        cityId: coverage.cityId,
        zoneId: coverage.zoneId,
        scheduledStart: priced.scheduledStart,
        scheduledEnd: priced.scheduledEnd,
      });
      if (!mounted.current || version !== careVersion.current) return;
      setQuote(priced.quote); setScheduledStart(priced.scheduledStart); setScheduledEnd(priced.scheduledEnd);
      setProviders(preview);
      if (providerSelection === "auto") setSelectedProviderId(suggestedGroomerId(preview));
      else if (!preview.providers.some(item => item.id === selectedProviderId)) setProviderError("Your chosen groomer is unavailable for this slot. Choose another groomer or ask PawSpace to match one.");
      if (!preview.providers.length) setProviderError("No groomer is available for this exact slot. Try another time.");
    } catch (problem) {
      if (!mounted.current || version !== careVersion.current) return;
      setQuote(null);
      setProviderError(problem instanceof Error ? problem.message : "We could not check this slot.");
    } finally {
      if (mounted.current && version === careVersion.current) setProviderBusy(false);
    }
  };

  useEffect(()=>{if(!booking&&!recoveryBookingId)return;setGuestPackageCode("");try{window.sessionStorage.removeItem("pawspace_v2_grooming_guest_package");}catch{/* No draft survives a completed/recovered booking in this visit. */}},[booking,recoveryBookingId]);
  if (booking || recoveryBookingId) return <V2GroomingPaymentPanel
    key={booking?.bookingId || recoveryBookingId} bookingId={booking?.bookingId || recoveryBookingId}
    initialAddress={address} initialPincode={pincode} preparing={checkoutBusy} />;

  if (loading) return <main className={styles.loading}><span className={styles.loader}>✦</span><b>Preparing a beautiful grooming experience…</b></main>;

  if (guest && catalogue && !fatal) return <GroomingGuestPreview catalogue={catalogue} selectedCode={selectedPackageCode} onSelect={code => {setGuestPackageCode(code);setSelectedPackageCode(code);try{window.sessionStorage.setItem("pawspace_v2_grooming_guest_package",code);}catch{/* Keep the current visit usable without storage. */}}} onVerified={() => void bootstrap()}/>;

  if (fatal || !account || !catalogue) return (
    <main className={styles.errorPage}>
      <img src="/assets/pawspace-grooming-cartoon.webp" alt="" />
      <span>PAWSPACE V2 · GROOMING</span>
      <h1>We can’t begin this booking yet.</h1>
      <p>{fatal || "Your PawSpace family or grooming catalogue is unavailable."}</p>
      <div><Link href="/v2">Back to PawSpace V2</Link><button onClick={() => void bootstrap()}>Try again</button></div>
    </main>
  );


  return (
    <main className={styles.page} aria-busy={checkoutBusy} data-v2-hero-page="true">
      <div className={styles.ambient} />
      <header className={styles.nav}>
        <Link href="/v2" className={styles.brand}><img src="/assets/pawspace-official-lockup.png" alt="PawSpace" /></Link>
        <nav className={styles.stepNavigation} aria-label="Booking steps">
          {GROOMING_STEPS.map(step => <button key={step.number} type="button"
            aria-controls={step.id} aria-current={activeStep === step.number ? "step" : undefined}
            disabled={Boolean(stepAccess[step.number])} title={stepAccess[step.number] || `Go to ${step.label.toLowerCase()} without losing your details`}
            onClick={() => navigateToStep(step)}><b>{step.number}</b><span>{step.label}</span></button>)}
        </nav>
        <Link href="/v2" className={styles.close} aria-label="Close grooming booking">×</Link>
      </header>
      <div className={styles.backBar} aria-label="Previous step">
        {previousStep ? <button type="button" onClick={() => navigateToStep(previousStep)}>← Back to {previousStep.label}</button> : <Link href="/v2">← Back to PawSpace</Link>}
        <span>Step {activeStep} of {GROOMING_STEPS.length}{currentStep ? ` · ${currentStep.label}` : ""}</span>
      </div>

      <section className={styles.hero}>
        <div>
          <span className={styles.eyebrow}>DOORSTEP GROOMING · V2</span>
          <h1>A calmer spa day,<br /><em>right at home.</em></h1>
          <p>Choose your pet, care package and time. PawSpace checks live serviceability, pricing and groomer availability before anything is reserved.</p>
        </div>
        <div className={styles.heroArt}>
          <span>Doorstep care</span>
          <img src="/assets/pawspace-grooming-editorial.webp" alt="Pet enjoying PawSpace grooming" />
        </div>
      </section>

      {guestPackageCode && <p role="status" className={styles.helper}>Your guest choice: {[...catalogue.packages,...subscriptionPackages].find(pkg => pkg.code === guestPackageCode)?.name || "a previously selected package"}. {packages.some(pkg => pkg.code === guestPackageCode) ? "The package is selected for your current pets. Check the final price and availability." : "This choice does not match your current pet selection. Choose the matching pets or a compatible package below before booking."}</p>}
      {largeHousehold && <section id="v2-large-family-enquiry" tabIndex={-1} role="dialog" aria-modal="false" aria-label="Large pet family enquiry" className={styles.step}>
        <h2>Plan care for more than four pets</h2><p>Your four-pet booking is unchanged. Send a separate enquiry for the full family; this does not confirm a booking.</p>
        <ContactForm initial={{name:account.name,phone:account.primaryPhone,service:"Grooming",petNames:largeHousehold.join(", "),message:`Please plan grooming for ${largeHousehold.length} pets: ${largeHousehold.join(", ")}. Requested date: ${date}.`}}/>
        <button type="button" onClick={() => setLargeHousehold(null)}>Return to booking</button>
      </section>}
      <div className={styles.layout}>
        <fieldset className={styles.journey} disabled={checkoutBusy}>
          <section id="v2-grooming-pets" tabIndex={-1} aria-labelledby="v2-grooming-pets-title" className={styles.step} onFocusCapture={() => setActiveStep(1)}>
            <div className={styles.stepHead}><span>01</span><div><small>YOUR FAMILY</small><h2 id="v2-grooming-pets-title">Who’s getting pampered?</h2></div></div>
            <div className={styles.petGrid}>
              {account.pets.map(pet => {
                const selected = selectedPetIds.includes(pet.id);
                return <button key={pet.id} className={`${styles.petCard} ${selected ? styles.selected : ""}`} aria-pressed={selected} onClick={() => togglePet(pet.id)}>
                  <span className={styles.petAvatar}>{String(pet.species).toLowerCase() === "cat" ? "🐱" : "🐶"}</span>
                  <div><b>{pet.name}</b><small>{pet.breed || pet.species} · {pet.ageYears != null ? `${pet.ageYears} yrs` : "age on profile"}</small></div>
                  <strong>{selected ? "✓" : "+"}</strong>
                </button>;
              })}
            </div>
            <button type="button" className={styles.liveButton} aria-expanded={addingPet} onClick={() => setAddingPet(open => !open)}>{addingPet ? "Close pet form" : account.pets.length ? "＋ Add another pet" : "＋ Add your pet to start"}</button>
            {addingPet && <PetManager customer={{ customerId: account.customerId, customerName: account.name, phone: account.primaryPhone }} onPetsChanged={pets => {
              const known = new Set(account.pets.map(pet => pet.id)), added = pets.find(pet => !known.has(pet.id));
              setAccount(current => current ? { ...current, pets } as CustomerAccountRecord : current);
              if (added) { invalidateCare(); setSelectedPetIds([added.id]); setAddingPet(false); }
            }} />}
            <p className={styles.helper}>{selectedPetIds.length}/4 pets selected. Multi-pet prices come from the governed catalogue. More than four opens a team enquiry.</p>
            {mixedAudience && <p id="v2-selection-issue" className={styles.inlineError} role="alert">{selectionIssue}</p>}
          </section>

          <section id="v2-grooming-package" tabIndex={-1} aria-labelledby="v2-grooming-package-title" className={styles.step} onFocusCapture={() => setActiveStep(2)}>
            <div className={styles.stepHead}><span>02</span><div><small>CARE EDIT</small><h2 id="v2-grooming-package-title">Choose their grooming ritual</h2></div></div>
            {packages.length ? <div className={styles.packageGrid}>
              {packages.map(pkg => {
                const option = groomingBundleForCount(pkg, selectedPets.length);
                const selected = selectedPackage?.code === pkg.code;
                return <button key={pkg.code} className={`${styles.packageCard} ${selected ? styles.selectedPackage : ""}`} onClick={() => { invalidateCare(); setGuestPackageCode("");try{window.sessionStorage.removeItem("pawspace_v2_grooming_guest_package");}catch{/* Current selection remains usable. */} setSelectedPackageCode(pkg.code); if(pkg.subscription)setPaymentMode("prepaid"); }} disabled={mixedAudience || !option}>
                  <div className={styles.packageTop}><span>{pkg.subscription ? "Subscription" : "One-time"} · {AUDIENCE_LABEL[pkg.audience]}</span>{selected && <strong>Selected</strong>}</div>
                  <h3>{pkg.name}</h3>
                  <p>{pkg.description}</p>
                  {pkg.subscription && <p>{pkg.subscription.sessions} {pkg.subscription.familyWallet?"shared credits":"credits"} · valid {pkg.subscription.validityValue} {pkg.subscription.validityUnit} · {pkg.subscription.creditsPerPet} credit(s) per pet per visit. {(() => {const care=catalogue.packages.find(p=>p.code===pkg.subscription?.servicePackageCode);const saving=care?subscriptionSavings(pkg,care):null;return saving===null?"Equivalent one-time savings unavailable.":`Save ${money(saving)} versus equivalent published one-time catalogue care. Actual single-visit prices can vary.`;})()}</p>}
                  <div className={styles.packageBottom}><b>{option ? money(option.price) : "Unavailable"}</b><small>{option ? `${option.slotMinutes} min · ${selectedPets.length} ${selectedPets.length === 1 ? "pet" : "pets"}` : "This bundle is not published"}</small></div>
                </button>;
              })}
            </div> : <div className={styles.empty}>No published package supports this pet selection yet.</div>}
            {youngIssue && <p id="v2-young-issue" className={styles.inlineError} role="alert">{youngIssue.message}{youngIssue.fix && <> <a href="/v2/account">{youngIssue.fix === "add_date_of_birth" ? "Add a date of birth in your account" : "Update the date of birth in your account"}</a>.</>}</p>}
            {extraCare && <p className={styles.helper} role="note">{extraCare}</p>}
            {selectedPackage && bundle && <div className={styles.packageDetail} aria-label="Selected package details">
              <div className={styles.packageDetailHead}><span>SELECTED PACKAGE · {money(bundle.price)} for {selectedPets.length} {selectedPets.length === 1 ? "pet" : "pets"}</span><b>{selectedPackage.name}</b><small>{selectedPackage.description}</small></div>
              {packageTruth ? <div className={styles.inclusionColumns}>
                <div><b>Included</b><ul>{packageTruth.included.map(item => <li key={item}>✓ {item}</li>)}</ul></div>
                <div><b>Not included</b>{packageTruth.excluded.length ? <ul>{packageTruth.excluded.map(item => <li key={item}>— {item}</li>)}</ul> : <p>Nothing from this package&apos;s published list is left out.</p>}</div>
              </div> : <p className={styles.helper}>The itemised inclusion list for this package is not published in the commercial catalogue; the description above is what PawSpace has confirmed.</p>}
              {availableAddOns.length > 0 && <details className={styles.addOnPicker} open={chosenAddOns.length > 0}>
                <summary>Add-ons · add extra services to your grooming{chosenAddOns.length ? ` (${chosenAddOns.length} selected)` : ""}</summary>
                {availableAddOns.map(item => <label key={item.label}><input type="checkbox" checked={chosenAddOns.includes(item.label)} onChange={event => { invalidateCare(); setAddOns(current => event.target.checked ? [...current.filter(label => label !== item.label), item.label] : current.filter(label => label !== item.label)); }} /> <span>{item.label}</span><b>{money(item.price)}</b></label>)}
                <small>Add-on prices are the published commercial catalogue prices and are added to your total below.</small>
              </details>}
              <label style={{ display: "block", marginTop: 8 }}>How is your pet with grooming?<select style={{ display: "block", width: "100%", maxWidth: "100%" }} value={comfort} onChange={event => setComfort(event.target.value as typeof comfort)}><option value="friendly">Friendly / comfortable with grooming</option><option value="anxious">Anxious or first grooming</option><option value="aggressive">Aggressive / bite history</option></select></label>
              <label style={{ display: "block", marginTop: 8 }}>Notes for your groomer (optional)<textarea maxLength={300} value={specialInstructions} onChange={event => setSpecialInstructions(event.target.value)} placeholder="e.g. Sensitive paws, please use the balcony tap" style={{ display: "block", width: "100%", maxWidth: "100%" }} /></label>
            </div>}
          </section>

          <section id="v2-grooming-address" tabIndex={-1} aria-labelledby="v2-grooming-address-title" className={styles.step} onFocusCapture={() => setActiveStep(3)}>
            <div className={styles.stepHead}><span>03</span><div><small>SERVICE DOORSTEP</small><h2 id="v2-grooming-address-title">Where should we come?</h2></div></div>
            <GroomingCustomerIntake account={account} disabled={checkoutBusy} onProfileSaved={setAccount} />
            <p className={styles.helper}>Save your contact details and address once, then reuse them for future visits. Pet photos are optional in your pet profile.</p>
            {account.addresses.length>0&&<label>Saved service address<select style={{display:"block",width:"100%",maxWidth:"100%"}} value={savedAddressId} onChange={event=>{const saved=account.addresses.find(item=>item.id===event.target.value);setSavedAddressId(event.target.value);if(saved){setAddress(serviceAddressText({...saved,postalCode:undefined}));setPincode(saved.postalCode||"");}invalidateDoorstep();}}><option value="">Enter a different address</option>{account.addresses.map(item=><option key={item.id} value={item.id}>{item.label}: {item.line1}{item.isDefault?" (default)":""}</option>)}</select></label>}
            <GroomingVerifiedAddressPicker disabled={checkoutBusy} onInvalidated={() => {
              if(checkoutLock.current)return;
              invalidateDoorstep();setCoverageError("");setAddress("");setPincode("");setSavedAddressId("");setSaveAddress(false);
            }} onSelect={draft => {
              if(checkoutLock.current)return;
              invalidateDoorstep();setCoverageError("");setAddress(draft.address);setPincode(draft.pincode);setSavedAddressId("");setSaveAddress(false);setCoverage(draft.coverage);
            }}/>
            <details><summary>Use device location instead</summary>
            <GroomingLocationAssist key={JSON.stringify([account.customerId, address, pincode, savedAddressId, locationRevision])}
              disabled={checkoutBusy} onPendingChange={onLocationPendingChange} onManualEntry={editServiceAddress}
              onConfirm={draft => {
                if (checkoutLock.current) return;
                invalidateDoorstep(); setCoverageError(""); setAddress(draft.address); setPincode(draft.pincode);
                setSavedAddressId(""); setSaveAddress(false); setLocationRevision(value => value + 1);
                addressInputRef.current?.focus();
              }} />
            </details>
            {address && <button type="button" className={styles.liveButton} onClick={editServiceAddress}>Change address</button>}
            <div className={styles.addressBox}>
              <label><span>House, street & area</span><input ref={addressInputRef} value={address} onChange={e => { setAddress(e.target.value); setSavedAddressId(""); invalidateDoorstep(); }} placeholder="e.g. 21, 18th Main, HSR Layout" /></label>
              <label className={styles.pinField}><span>PIN code</span><input inputMode="numeric" value={pincode} onChange={e => { setPincode(e.target.value.replace(/\D/g, "").slice(0, 6)); setSavedAddressId(""); invalidateDoorstep(); }} placeholder="560102" /></label>
              <div style={{ gridColumn: "1 / -1" }}>{coverageBusy ? <p role="status" className={styles.helper}>Checking serviceability for this address…</p>
                : coverageError ? <button type="button" onClick={() => void verifyCoverage()} disabled={locationPending || pincode.length !== 6}>Check this address again</button>
                : !coverage && <p className={styles.helper}>Serviceability is checked automatically once your house line and six-digit PIN are in.</p>}</div>
            </div>
            {!savedAddressId && address.trim().length >= 8 && <label className={styles.helper}><input type="checkbox" checked={saveAddress} onChange={event => setSaveAddress(event.target.checked)} /> Save this address to my account</label>}
            {coverage && <div className={styles.coverageSuccess}><span>✓</span><div><b>{coverage.zoneName} is covered</b><small>{coverage.area}, {coverage.city} · {coverage.pincode}</small></div><strong>AREA</strong></div>}
            {coverage && <p className={styles.helper}>Service area matched only. The complete doorstep must still be map-verified before payment.</p>}
            {coverageError && <p role="alert" className={styles.inlineError}>{coverageError}</p>}
          </section>

          <section id="v2-grooming-time" tabIndex={-1} aria-labelledby="v2-grooming-time-title" className={styles.step} onFocusCapture={() => setActiveStep(4)}>
            <div className={styles.stepHead}><span>04</span><div><small>LIVE AVAILABILITY</small><h2 id="v2-grooming-time-title">Pick a beautiful time</h2></div></div>
            <div className={styles.dateStrip}>{dates.map(item => <button key={item.isoDate} aria-pressed={date === item.isoDate} className={date === item.isoDate ? styles.dateSelected : ""} onClick={() => { invalidateCare(); setDate(item.isoDate); }}><small>{item.day}</small><b>{item.date}</b></button>)}</div>
            <div className={styles.slotGrid}>{SLOT_LABELS.map((label, index) => {
              const available = Boolean(bundle && date && groomingSlotAvailable(date, index, bundle.slotMinutes));
              return <button key={label} disabled={!available} className={slotIndex === index ? styles.slotSelected : ""} onClick={() => { invalidateCare(); setSlotIndex(index); }}><span>{available&&bundle?formatIndiaRange(groomingSlotWindow(date,index,bundle.slotMinutes).start,groomingSlotWindow(date,index,bundle.slotMinutes).end):label}</span><small>{available ? "Select" : "Unavailable"}</small></button>;
            })}</div>
            <button className={styles.liveButton} disabled={!bundle || !coverage || mixedAudience || Boolean(youngIssue) || providerBusy || locationPending} aria-describedby={blockingIssue?.id} onClick={() => void checkLiveCare()}><span>✦</span>{providerBusy ? "Confirming price & groomers…" : "Next · confirm price & groomers"}</button>
            {blockingIssue && <p className={styles.helper}>Resolve the issue in step {blockingIssue.step} to continue.</p>}
            <p className={styles.helper}>Next confirms the exact live price and an available groomer for this slot, then takes you to payment review. Nothing is reserved yet.</p>
            {providerError && <p role="alert" className={styles.inlineError}>{providerError}</p>}
          </section>

          {providers && providers.providers.length > 0 && <section className={styles.step}>
            <div className={styles.stepHead}><span>05</span><div><small>CARE PROFESSIONAL</small><h2>Available for this exact slot</h2></div></div>
            <p className={styles.helper}>PawSpace can choose the best eligible groomer at reservation, or you can select one person. A specific choice is never silently replaced.</p>
            <button type="button" className={`${styles.providerCard} ${providerSelection === "auto" ? styles.providerSelected : ""}`} aria-pressed={providerSelection === "auto"} onClick={() => { setProviderSelection("auto"); setProviderError(""); }}>PawSpace chooses the best available groomer</button>
            <div className={styles.providerGrid}>{providers.providers.map(provider => <button key={provider.id} className={`${styles.providerCard} ${providerSelection === "specific" && selectedProviderId === provider.id ? styles.providerSelected : ""}`} aria-pressed={providerSelection === "specific" && selectedProviderId === provider.id} onClick={() => { setProviderSelection("specific"); setSelectedProviderId(provider.id); setProviderError(""); }}>
              <span className={styles.providerAvatar}>{provider.name.slice(0, 1).toUpperCase()}</span>
              <div><b>{provider.name}</b><small>{provider.model === "full_time" ? "PawSpace care professional" : "Verified care partner"}</small>{provider.rating ? <em>★ {provider.rating.toFixed(1)}</em> : <em>Availability verified</em>}</div>
              <strong>{providerSelection === "specific" && selectedProviderId === provider.id ? "✓" : "Choose"}</strong>
            </button>)}</div>
          </section>}
        </fieldset>

        <aside id="v2-grooming-summary" className={styles.summary}>
          <div className={styles.summaryTop}><span>YOUR CARE PLAN</span><b>{quote ? "Live price checked" : "Your selected care"}</b></div>
          <div className={styles.summaryPet}><img src="/assets/pawspace-grooming-cartoon.webp" alt="" /><div><b>{selectedPets.map(pet => pet.name).join(" + ") || "Choose your pet"}</b><small>{selectedPets.length ? `${selectedPets.length} ${selectedPets.length === 1 ? "pet" : "pets"}` : "No pet selected"}</small></div></div>
          <div className={styles.summaryRows}>
            <div><span>Package</span><b>{selectedPackage?.name || "—"}</b></div>
            <div><span>Doorstep</span><b>{coverage ? `${address.trim()}, ${coverage.pincode}` : "Verify address"}</b></div>
            <div><span>When</span><b>{summaryWhen}</b></div>
            <div><span>Groomer</span><b>{providerSelection === "auto" ? "PawSpace chooses · confirmed at reservation" : providers?.providers.find(item => item.id === selectedProviderId)?.name || "Selected groomer unavailable"}</b></div>
          </div>
          <div className={styles.priceBlock}><span>{quote ? "Verified live price" : "Package price"}</span><b>{quote ? money(quote.price + addOnTotal) : bundle ? money(bundle.price + addOnTotal) : "—"}</b>{addOnTotal > 0 && <small>Includes extras {money(addOnTotal)}</small>}<small>{quote ? (quote.source === "subscription_control" ? "Confirmed from Subscription Control" : quote.source === "pricing_control" ? "Confirmed from Pricing Control" : "Confirmed canonical package price") : "Final price checks your exact slot and zone"}</small></div>
          {quote && basketTotal !== null && account && coverage && bundle && <V2GroomingCouponBox key={couponContextKey} contextKey={couponContextKey} isSubscription={Boolean(selectedPackage?.subscription)} intentRef={couponIntentRef} onChecked={setCouponCheckedKey} orderValue={basketTotal} customerId={account.customerId} cityId={coverage.cityId} packageCode={bundle.packageCode} paymentMode={paymentMode} onChange={onCouponChange} />}
          {quote && coupon.quoteId && <div className={styles.priceBlock}><span>Coupon {coupon.code} · −{money(coupon.discount)}</span><b>{money(Math.max(0, quote.price + addOnTotal - coupon.discount))}</b><small>Total after the server-checked coupon</small></div>}
          {selectedPackage?.subscription && <p className={styles.helper}>Subscription purchase is prepaid. Credits activate only after verified payment under the existing wallet policy.</p>}
          {quote && <div className={styles.addressBox} role="group" aria-label="Payment timing">
            <b>How would you like to pay?</b>
            <div className={styles.providerGrid}>
              <button type="button" className={paymentMode === "prepaid" ? styles.providerSelected : styles.providerCard} aria-pressed={paymentMode === "prepaid"} onClick={() => { setPaymentMode("prepaid"); setCouponCheckedKey(""); }}>
                <div><b>Pay now</b><small>Secure Razorpay / UPI checkout</small></div><strong>{paymentMode === "prepaid" ? "✓" : "Choose"}</strong>
              </button>
              <button type="button" className={paymentMode === "pay_after_service" ? styles.providerSelected : styles.providerCard} aria-pressed={paymentMode === "pay_after_service"} disabled={Boolean(selectedPackage?.subscription)} onClick={() => { setPaymentMode("pay_after_service"); setCouponCheckedKey(""); }}>
                <div><b>Pay after service</b><small>₹0 now · settle by payment link / UPI or cash after grooming</small></div><strong>{paymentMode === "pay_after_service" ? "✓" : "Choose"}</strong>
              </button>
            </div>
            <small>No split payment for Grooming. Cash is recorded by the provider and reconciled by Accounts.</small>
          </div>}
          <TestCoinServicePreview serviceName="Grooming" customerId={account?.customerId} eligibleAmount={coinQuote.eligibleAmount} actualPayable={coinQuote.actualPayable}/>
          <div className={styles.safe}><span>◆</span><p><b>Nothing reserved yet.</b> Review your care details. The next step creates one booking; {paymentMode === "prepaid" ? "secure payment opens only after its doorstep is verified." : "nothing is charged now and the balance is due after service."}</p></div>
          <button className={styles.continue} disabled={!quote || basketTotal === null || !coverage || !(providerSelection === "auto" ? providers?.providers.length : providers?.providers.some(item => item.id === selectedProviderId)) || !scheduledStart || !scheduledEnd || checkoutBusy || providerBusy || mixedAudience || Boolean(youngIssue) || couponChecking || couponNeedsReapply(coupon.code, coupon.quoteId) || locationPending} aria-describedby={locationPending ? "v2-location-review-pending" : blockingIssue?.id} onClick={() => void beginSecureCheckout()}>{checkoutBusy ? "Reserving…" : paymentMode === "prepaid" ? "Next · review payment" : "Next · reserve, pay after service"} <span>→</span></button>
          {locationPending && <p id="v2-location-review-pending" role="status" className={styles.helper}>Review or cancel the current-location suggestion before reserving.</p>}
          {checkoutError && <p role="alert" className={styles.inlineError}>{checkoutError}</p>}
          <small className={styles.footnote}>Reservation and payment begin only after you press the secure checkout button.</small>
        </aside>
        <div className={styles.stickyTotal} role="status" aria-label="Running total">
          <div><span>{quote ? (couponApplied ? `Total after coupon ${coupon.code}` : "Verified live price") : selectedPackage ? "Package price" : "No package selected"}</span><b>{quote ? money(couponApplied ? Math.max(0, quote.price + addOnTotal - coupon.discount) : quote.price + addOnTotal) : bundle ? money(bundle.price + addOnTotal) : "—"}</b>{addOnTotal > 0 && <small>incl. add-ons {money(addOnTotal)}</small>}{couponApplied && <small>{money(quote!.price + addOnTotal)} − {money(coupon.discount)} coupon</small>}{quote && couponChecking && <small>Checking coupon…</small>}{quote && !couponChecking && couponNeedsReapply(coupon.code, coupon.quoteId) && <small>Coupon {coupon.code} needs re-applying</small>}</div>
          <button type="button" onClick={() => { const next = quote ? "v2-grooming-summary" : coverage ? "v2-grooming-time" : selectedPackage ? "v2-grooming-address" : "v2-grooming-package"; document.getElementById(next)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>{quote ? "Review & pay" : "Next"}</button>
        </div>
      </div>
    </main>
  );
}
