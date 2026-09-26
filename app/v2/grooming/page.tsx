"use client";
/* eslint-disable @next/next/no-img-element, react-hooks/set-state-in-effect */

import Link from "next/link";
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
} from "../../../lib/v2/grooming-checkout-client";
import { useQueryParameter } from "../../../lib/use-query-parameter";
import V2GroomingPaymentPanel from "./payment-panel";
import V2GroomingCouponBox from "./coupon-box";
import ContactForm from "../../contact/contact-form";
import { serviceAddressConflict } from "../../../lib/service-address-consistency";
import { EXTRA_CARE_MINUTES, v2ExtraCareReason, v2GroomingPetAudience, v2GroomingSelectionIssue, v2YoungPackageIssue } from "../../../lib/v2/grooming-selection";
import styles from "./grooming.module.css";
import {formatIndiaRange} from "../../../lib/india-time";
import {serviceAddressText} from "../../../lib/service-address-text";
import PetManager from "../pet-form";
import { groomingAddOnsForSpecies } from "../../../lib/grooming-add-ons";

const SLOT_LABELS = ["9:00 – 11:00 AM", "11:00 AM – 1:00 PM", "1:00 – 3:00 PM", "3:00 – 5:00 PM", "5:00 – 7:00 PM"];
const AUDIENCE_LABEL: Record<V2GroomingPackage["audience"], string> = { dog: "Dogs", cat: "Cats", young: "Puppies & kittens" };
const money = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value);

export default function V2GroomingPage() {
  const recoveryBookingId = useQueryParameter("bookingId");
  const [account, setAccount] = useState<CustomerAccountRecord | null>(null);
  const [catalogue, setCatalogue] = useState<V2GroomingCatalogue | null>(null);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState("");
  const [selectedPetIds, setSelectedPetIds] = useState<string[]>([]);
  // New customers used to reach a dead end here: pets could only be added in V2 Account.
  const [addingPet, setAddingPet] = useState(false);
  // Owner decision (H4): the in-app extras, in V2 before launch.
  const [addOns, setAddOns] = useState<string[]>([]);
  const [comfort, setComfort] = useState<"friendly" | "anxious" | "aggressive">("friendly");
  const [specialInstructions, setSpecialInstructions] = useState("");
  const [largeHousehold, setLargeHousehold] = useState<string[] | null>(null);
  const [selectedPackageCode, setSelectedPackageCode] = useState("");
  const [address, setAddress] = useState("");
  const [savedAddressId, setSavedAddressId] = useState("");
  // A typed doorstep is kept in the account only when the customer asks; availability checks never save it.
  const [saveAddress, setSaveAddress] = useState(false);
  const [pincode, setPincode] = useState("");
  const [coverage, setCoverage] = useState<ResolvedServiceCoverage | null>(null);
  const [coverageBusy, setCoverageBusy] = useState(false);
  const [coverageError, setCoverageError] = useState("");
  const [date, setDate] = useState("");
  const [slotIndex, setSlotIndex] = useState(1);
  const [quote, setQuote] = useState<V2GroomingQuote | null>(null);
  const [scheduledStart, setScheduledStart] = useState("");
  const [scheduledEnd, setScheduledEnd] = useState("");
  const [providers, setProviders] = useState<ProviderPreview | null>(null);
  const [providerBusy, setProviderBusy] = useState(false);
  const [providerError, setProviderError] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [booking, setBooking] = useState<V2GroomingBooking | null>(null);
  const [checkoutError, setCheckoutError] = useState("");
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  // A governed coupon quote for this exact live price; the server decides the discount and re-checks it at booking.
  const [coupon, setCoupon] = useState({ discount: 0, code: "", quoteId: "" });
  const onCouponChange = useCallback((discount: number, code: string, quoteId?: string) => setCoupon({ discount, code, quoteId: quoteId || "" }), []);
  const checkoutLock = useRef(false), mounted = useRef(true);
  const coverageVersion = useRef(0), careVersion = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const bootstrap = useCallback(async () => {
    setLoading(true);
    setFatal("");
    try {
      const [session, availability, nextCatalogue] = await Promise.all([
        loadV2CustomerSession(),
        loadV2ServiceAvailability(),
        loadV2GroomingCatalogue(),
      ]);
      if (!session) throw new Error("Sign in from PawSpace V2 before booking grooming.");
      const grooming = availability.find(service => service.code === "grooming");
      if (!grooming?.enabled) throw new Error("Grooming is not accepting bookings in your area right now.");
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
  const packages = useMemo(
    () => (catalogue?.packages || []).filter(pkg => pkg.audience === audience && Boolean(groomingBundleForCount(pkg, selectedPets.length))),
    [catalogue, audience, selectedPets.length],
  );
  const selectedPackage = packages.find(pkg => pkg.code === selectedPackageCode) || packages[0] || null;
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
  const summaryWhen=useMemo(()=>{if(!date||!bundle)return "Choose a date and package";try{const window=groomingSlotWindow(date,slotIndex,bundle.slotMinutes);return formatIndiaRange(scheduledStart||window.start,scheduledEnd||window.end);}catch{return "Choose a time that fits the full service duration";}},[date,slotIndex,bundle,scheduledStart,scheduledEnd]);
  const [dates] = useState(() => groomingBookingDates(Date.now(), 14));

  useEffect(() => {
    if (selectedPackage && selectedPackage.code !== selectedPackageCode) setSelectedPackageCode(selectedPackage.code);
  }, [selectedPackage, selectedPackageCode]);

  const invalidateCare = () => {
    careVersion.current++;
    setProviderBusy(false);
    setScheduledStart(""); setScheduledEnd("");
    setQuote(null); setCoupon({ discount: 0, code: "", quoteId: "" });
    setProviders(null);
    setSelectedProviderId("");
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

  const verifyCoverage = async () => {
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
  };

  const beginSecureCheckout = async () => {
    if (checkoutLock.current || providerBusy || mixedAudience || youngIssue) return;
    const provider = providers?.providers.find(item => item.id === selectedProviderId);
    if (!account || !selectedPackage || !bundle || !quote || !coverage || !provider || !scheduledStart || !scheduledEnd) return;
    checkoutLock.current = true; setCheckoutBusy(true); setCheckoutError("");
    try {
      await createV2GroomingBooking({
        account, selectedPets, pkg: selectedPackage, bundle, quote, provider,
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
    if (!account || !bundle || !coverage || !date || mixedAudience || youngIssue) return;
    const version = ++careVersion.current;
    setQuote(null); setCoupon({ discount: 0, code: "", quoteId: "" });
    setProviderBusy(true);
    setProviderError("");
    setProviders(null);
    setSelectedProviderId("");
    try {
      if (!groomingSlotAvailable(date, slotIndex, bundle.slotMinutes)) throw new Error("That grooming slot can no longer be booked. Pick another time.");
      const priced = await quoteV2Grooming({ bundle, isoDate: date, slotIndex, cityId: coverage.cityId, zoneId: coverage.zoneId });
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
      if (preview.providers.length === 1) setSelectedProviderId(preview.providers[0].id);
      if (!preview.providers.length) setProviderError("No groomer is available for this exact slot. Try another time.");
    } catch (problem) {
      if (!mounted.current || version !== careVersion.current) return;
      setQuote(null);
      setProviderError(problem instanceof Error ? problem.message : "We could not check this slot.");
    } finally {
      if (mounted.current && version === careVersion.current) setProviderBusy(false);
    }
  };

  if (booking || recoveryBookingId) return <V2GroomingPaymentPanel
    key={booking?.bookingId || recoveryBookingId} bookingId={booking?.bookingId || recoveryBookingId}
    initialAddress={address} initialPincode={pincode} preparing={checkoutBusy} />;

  if (loading) return <main className={styles.loading}><span className={styles.loader}>✦</span><b>Preparing a beautiful grooming experience…</b></main>;

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
    <main className={styles.page} aria-busy={checkoutBusy}>
      <div className={styles.ambient} />
      <header className={styles.nav}>
        <Link href="/v2" className={styles.brand}><img src="/assets/pawspace-official-lockup.png" alt="PawSpace" /></Link>
        <div className={styles.progress}><i className={styles.active} /><i /><i /><i /><span>Doorstep grooming</span></div>
        <Link href="/v2" className={styles.close} aria-label="Close grooming booking">×</Link>
      </header>

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

      {largeHousehold && <section id="v2-large-family-enquiry" tabIndex={-1} role="dialog" aria-modal="false" aria-label="Large pet family enquiry" className={styles.step}>
        <h2>Plan care for more than four pets</h2><p>Your four-pet booking is unchanged. Send a separate enquiry for the full family; this does not confirm a booking.</p>
        <ContactForm initial={{name:account.name,phone:account.primaryPhone,service:"Grooming",petNames:largeHousehold.join(", "),message:`Please plan grooming for ${largeHousehold.length} pets: ${largeHousehold.join(", ")}. Requested date: ${date}.`}}/>
        <button type="button" onClick={() => setLargeHousehold(null)}>Return to booking</button>
      </section>}
      <div className={styles.layout}>
        <fieldset className={styles.journey} disabled={checkoutBusy}>
          <section className={styles.step}>
            <div className={styles.stepHead}><span>01</span><div><small>YOUR FAMILY</small><h2>Who’s getting pampered?</h2></div></div>
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

          <section className={styles.step}>
            <div className={styles.stepHead}><span>02</span><div><small>CARE EDIT</small><h2>Choose their grooming ritual</h2></div></div>
            {packages.length ? <div className={styles.packageGrid}>
              {packages.map(pkg => {
                const option = groomingBundleForCount(pkg, selectedPets.length);
                const selected = selectedPackage?.code === pkg.code;
                return <button key={pkg.code} className={`${styles.packageCard} ${selected ? styles.selectedPackage : ""}`} onClick={() => { invalidateCare(); setSelectedPackageCode(pkg.code); }} disabled={mixedAudience || !option}>
                  <div className={styles.packageTop}><span>{AUDIENCE_LABEL[pkg.audience]}</span>{selected && <strong>Selected</strong>}</div>
                  <h3>{pkg.name}</h3>
                  <p>{pkg.description}</p>
                  <div className={styles.packageBottom}><b>{option ? money(option.price) : "Unavailable"}</b><small>{option ? `${option.slotMinutes} min · ${selectedPets.length} ${selectedPets.length === 1 ? "pet" : "pets"}` : "This bundle is not published"}</small></div>
                </button>;
              })}
            </div> : <div className={styles.empty}>No published package supports this pet selection yet.</div>}
            {youngIssue && <p id="v2-young-issue" className={styles.inlineError} role="alert">{youngIssue.message}{youngIssue.fix && <> <a href="/v2/account">{youngIssue.fix === "add_date_of_birth" ? "Add a date of birth in your account" : "Update the date of birth in your account"}</a>.</>}</p>}
            {extraCare && <p className={styles.helper} role="note">{extraCare}</p>}
            {availableAddOns.length > 0 && <div className={styles.helper} aria-label="Extras and care notes">
              <b>Extras</b>{availableAddOns.map(item => <label key={item.label} style={{ display: "block" }}><input type="checkbox" checked={chosenAddOns.includes(item.label)} onChange={event => { invalidateCare(); setAddOns(current => event.target.checked ? [...current.filter(label => label !== item.label), item.label] : current.filter(label => label !== item.label)); }} /> {item.label} · {money(item.price)}</label>)}
              <label style={{ display: "block", marginTop: 8 }}>How is your pet with grooming?<select style={{ display: "block", width: "100%", maxWidth: "100%" }} value={comfort} onChange={event => setComfort(event.target.value as typeof comfort)}><option value="friendly">Friendly / comfortable with grooming</option><option value="anxious">Anxious or first grooming</option><option value="aggressive">Aggressive / bite history</option></select></label>
              <label style={{ display: "block", marginTop: 8 }}>Notes for your groomer (optional)<textarea maxLength={300} value={specialInstructions} onChange={event => setSpecialInstructions(event.target.value)} placeholder="e.g. Sensitive paws, please use the balcony tap" style={{ display: "block", width: "100%", maxWidth: "100%" }} /></label>
            </div>}
          </section>

          <section className={styles.step}>
            <div className={styles.stepHead}><span>03</span><div><small>SERVICE DOORSTEP</small><h2>Where should we come?</h2></div></div>
            {account.addresses.length>0&&<label>Saved service address<select style={{display:"block",width:"100%",maxWidth:"100%"}} value={savedAddressId} onChange={event=>{const saved=account.addresses.find(item=>item.id===event.target.value);setSavedAddressId(event.target.value);if(saved){setAddress(serviceAddressText({...saved,postalCode:undefined}));setPincode(saved.postalCode||"");}invalidateDoorstep();}}><option value="">Enter a different address</option>{account.addresses.map(item=><option key={item.id} value={item.id}>{item.label}: {item.line1}{item.isDefault?" (default)":""}</option>)}</select></label>}
            <div className={styles.addressBox}>
              <label><span>House, street & area</span><input value={address} onChange={e => { setAddress(e.target.value); setSavedAddressId(""); invalidateDoorstep(); }} placeholder="e.g. 21, 18th Main, HSR Layout" /></label>
              <label className={styles.pinField}><span>PIN code</span><input inputMode="numeric" value={pincode} onChange={e => { setPincode(e.target.value.replace(/\D/g, "").slice(0, 6)); setSavedAddressId(""); invalidateDoorstep(); }} placeholder="560102" /></label>
              <button onClick={() => void verifyCoverage()} disabled={coverageBusy || pincode.length !== 6}>{coverageBusy ? "Checking…" : "Check service area"}</button>
            </div>
            {!savedAddressId && address.trim().length >= 8 && <label className={styles.helper}><input type="checkbox" checked={saveAddress} onChange={event => setSaveAddress(event.target.checked)} /> Save this address to my account</label>}
            {coverage && <div className={styles.coverageSuccess}><span>✓</span><div><b>{coverage.zoneName} is covered</b><small>{coverage.area}, {coverage.city} · {coverage.pincode}</small></div><strong>AREA</strong></div>}
            {coverage && <p className={styles.helper}>Service area matched only. The complete doorstep must still be map-verified before payment.</p>}
            {coverageError && <p role="alert" className={styles.inlineError}>{coverageError}</p>}
          </section>

          <section className={styles.step}>
            <div className={styles.stepHead}><span>04</span><div><small>LIVE AVAILABILITY</small><h2>Pick a beautiful time</h2></div></div>
            <div className={styles.dateStrip}>{dates.map(item => <button key={item.isoDate} className={date === item.isoDate ? styles.dateSelected : ""} onClick={() => { invalidateCare(); setDate(item.isoDate); }}><small>{item.day}</small><b>{item.date}</b></button>)}</div>
            <div className={styles.slotGrid}>{SLOT_LABELS.map((label, index) => {
              const available = Boolean(bundle && date && groomingSlotAvailable(date, index, bundle.slotMinutes));
              return <button key={label} disabled={!available} className={slotIndex === index ? styles.slotSelected : ""} onClick={() => { invalidateCare(); setSlotIndex(index); }}><span>{available&&bundle?formatIndiaRange(groomingSlotWindow(date,index,bundle.slotMinutes).start,groomingSlotWindow(date,index,bundle.slotMinutes).end):label}</span><small>{available ? "Check live groomers" : "Unavailable"}</small></button>;
            })}</div>
            <button className={styles.liveButton} disabled={!bundle || !coverage || mixedAudience || Boolean(youngIssue) || providerBusy} aria-describedby={blockingIssue?.id} onClick={() => void checkLiveCare()}><span>✦</span>{providerBusy ? "Checking PawSpace live…" : "Check live price & groomers"}</button>
            {blockingIssue && <p className={styles.helper}>Resolve the issue in step {blockingIssue.step} to check live prices and groomers.</p>}
            {providerError && <p className={styles.inlineError}>{providerError}</p>}
          </section>

          {providers && providers.providers.length > 0 && <section className={styles.step}>
            <div className={styles.stepHead}><span>05</span><div><small>CARE PROFESSIONAL</small><h2>Available for this exact slot</h2></div></div>
            <div className={styles.providerGrid}>{providers.providers.map(provider => <button key={provider.id} className={`${styles.providerCard} ${selectedProviderId === provider.id ? styles.providerSelected : ""}`} onClick={() => setSelectedProviderId(provider.id)}>
              <span className={styles.providerAvatar}>{provider.name.slice(0, 1).toUpperCase()}</span>
              <div><b>{provider.name}</b><small>{provider.model === "full_time" ? "PawSpace care professional" : "Verified care partner"}</small>{provider.rating ? <em>★ {provider.rating.toFixed(1)}</em> : <em>Availability verified</em>}</div>
              <strong>{selectedProviderId === provider.id ? "✓" : "Choose"}</strong>
            </button>)}</div>
          </section>}
        </fieldset>

        <aside className={styles.summary}>
          <div className={styles.summaryTop}><span>YOUR CARE PLAN</span><b>{quote ? "Live price checked" : "Your selected care"}</b></div>
          <div className={styles.summaryPet}><img src="/assets/pawspace-grooming-cartoon.webp" alt="" /><div><b>{selectedPets.map(pet => pet.name).join(" + ") || "Choose your pet"}</b><small>{selectedPets.length ? `${selectedPets.length} ${selectedPets.length === 1 ? "pet" : "pets"}` : "No pet selected"}</small></div></div>
          <div className={styles.summaryRows}>
            <div><span>Package</span><b>{selectedPackage?.name || "—"}</b></div>
            <div><span>Doorstep</span><b>{coverage ? `${address.trim()}, ${coverage.pincode}` : "Verify address"}</b></div>
            <div><span>When</span><b>{summaryWhen}</b></div>
            <div><span>Groomer</span><b>{providers?.providers.find(item => item.id === selectedProviderId)?.name || (providers ? "Choose groomer" : "Checked after slot")}</b></div>
          </div>
          <div className={styles.priceBlock}><span>{quote ? "Verified live price" : "Package price"}</span><b>{quote ? money(quote.price + addOnTotal) : bundle ? money(bundle.price + addOnTotal) : "—"}</b>{addOnTotal > 0 && <small>Includes extras {money(addOnTotal)}</small>}<small>{quote ? (quote.source === "pricing_control" ? "Confirmed from Pricing Control" : "Confirmed canonical package price") : "Final price checks your exact slot and zone"}</small></div>
          {quote && account && coverage && bundle && <V2GroomingCouponBox key={`${quote.price}|${bundle.packageCode}|${scheduledStart}|${coverage.cityId}|${coverage.zoneId}`} orderValue={quote.price} customerId={account.customerId} cityId={coverage.cityId} packageCode={bundle.packageCode} onChange={onCouponChange} />}
          {quote && coupon.quoteId && <div className={styles.priceBlock}><span>Coupon {coupon.code} · −{money(coupon.discount)}</span><b>{money(Math.max(0, quote.price + addOnTotal - coupon.discount))}</b><small>Total after the server-checked coupon</small></div>}
          <div className={styles.safe}><span>◆</span><p><b>Nothing reserved yet.</b> Review your care details. The next step creates one booking; payment opens only after its doorstep is verified.</p></div>
          <button className={styles.continue} disabled={!quote || !coverage || !selectedProviderId || !scheduledStart || !scheduledEnd || checkoutBusy || providerBusy || mixedAudience || Boolean(youngIssue) || couponNeedsReapply(coupon.code, coupon.quoteId)} aria-describedby={blockingIssue?.id} onClick={() => void beginSecureCheckout()}>{checkoutBusy ? "Reserving…" : "Reserve & review payment"} <span>→</span></button>
          {checkoutError && <p role="alert" className={styles.inlineError}>{checkoutError}</p>}
          <small className={styles.footnote}>Reservation and payment begin only after you press the secure checkout button.</small>
        </aside>
      </div>
    </main>
  );
}
