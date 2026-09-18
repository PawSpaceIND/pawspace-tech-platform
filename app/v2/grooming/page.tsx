"use client";
/* eslint-disable @next/next/no-img-element, react-hooks/set-state-in-effect */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CustomerAccountRecord } from "../../../lib/customer-account";
import { groomingBookingDates, groomingSlotAvailable } from "../../../lib/grooming-booking-calendar";
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
import styles from "./grooming.module.css";

const SLOT_LABELS = ["9:00 – 11:00 AM", "11:00 AM – 1:00 PM", "1:00 – 3:00 PM", "3:00 – 5:00 PM", "5:00 – 7:00 PM"];
const AUDIENCE_LABEL: Record<V2GroomingPackage["audience"], string> = { dog: "Dogs", cat: "Cats", young: "Puppies & kittens" };
const money = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value);

function petAudience(pet: CustomerAccountRecord["pets"][number]): V2GroomingPackage["audience"] {
  const species = String(pet.species || "").toLowerCase();
  const age = pet.ageYears;
  if ((species === "dog" || species === "cat") && typeof age === "number" && age >= 0 && age <= 0.5) return "young";
  return species === "cat" ? "cat" : "dog";
}

export default function V2GroomingPage() {
  const recoveryBookingId = useQueryParameter("bookingId");
  const [account, setAccount] = useState<CustomerAccountRecord | null>(null);
  const [catalogue, setCatalogue] = useState<V2GroomingCatalogue | null>(null);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState("");
  const [selectedPetIds, setSelectedPetIds] = useState<string[]>([]);
  const [selectedPackageCode, setSelectedPackageCode] = useState("");
  const [address, setAddress] = useState("");
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
  const audience = selectedPets[0] ? petAudience(selectedPets[0]) : null;
  const mixedAudience = selectedPets.some(pet => audience && petAudience(pet) !== audience);
  const packages = useMemo(
    () => (catalogue?.packages || []).filter(pkg => pkg.audience === audience && Boolean(groomingBundleForCount(pkg, selectedPets.length))),
    [catalogue, audience, selectedPets.length],
  );
  const selectedPackage = packages.find(pkg => pkg.code === selectedPackageCode) || packages[0] || null;
  const bundle = selectedPackage ? groomingBundleForCount(selectedPackage, selectedPets.length) : null;
  const [dates] = useState(() => groomingBookingDates(Date.now(), 14));

  useEffect(() => {
    if (selectedPackage && selectedPackage.code !== selectedPackageCode) setSelectedPackageCode(selectedPackage.code);
  }, [selectedPackage, selectedPackageCode]);

  const invalidateCare = () => {
    careVersion.current++;
    setProviderBusy(false);
    setScheduledStart(""); setScheduledEnd("");
    setQuote(null);
    setProviders(null);
    setSelectedProviderId("");
    setProviderError("");
  };
  useEffect(() => { invalidateCare(); }, [selectedPetIds, selectedPackageCode, coverage?.zoneId, date, slotIndex]);
  const invalidateDoorstep = () => {
    coverageVersion.current++; setCoverageBusy(false); setCoverage(null); invalidateCare();
  };

  const togglePet = (id: string) => {
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
      if (mounted.current && version === coverageVersion.current) setCoverage(result);
    } catch (problem) {
      if (mounted.current && version === coverageVersion.current) setCoverageError(problem instanceof Error ? problem.message : "We could not verify this service address.");
    } finally {
      if (mounted.current && version === coverageVersion.current) setCoverageBusy(false);
    }
  };

  const beginSecureCheckout = async () => {
    if (checkoutLock.current || providerBusy || mixedAudience) return;
    const provider = providers?.providers.find(item => item.id === selectedProviderId);
    if (!account || !selectedPackage || !bundle || !quote || !coverage || !provider || !scheduledStart || !scheduledEnd) return;
    checkoutLock.current = true; setCheckoutBusy(true); setCheckoutError("");
    try {
      await createV2GroomingBooking({
        account, selectedPets, pkg: selectedPackage, bundle, quote, provider,
        address, pincode: coverage.pincode, cityId: coverage.cityId, zoneId: coverage.zoneId,
        scheduledStart, scheduledEnd,
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
    if (!account || !bundle || !coverage || !date || mixedAudience) return;
    const version = ++careVersion.current;
    setQuote(null);
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

      <div className={styles.layout}>
        <fieldset className={styles.journey} disabled={checkoutBusy}>
          <section className={styles.step}>
            <div className={styles.stepHead}><span>01</span><div><small>YOUR FAMILY</small><h2>Who’s getting pampered?</h2></div></div>
            <div className={styles.petGrid}>
              {account.pets.map(pet => {
                const selected = selectedPetIds.includes(pet.id);
                return <button key={pet.id} className={`${styles.petCard} ${selected ? styles.selected : ""}`} onClick={() => togglePet(pet.id)}>
                  <span className={styles.petAvatar}>{String(pet.species).toLowerCase() === "cat" ? "🐱" : "🐶"}</span>
                  <div><b>{pet.name}</b><small>{pet.breed || pet.species} · {pet.ageYears != null ? `${pet.ageYears} yrs` : "age on profile"}</small></div>
                  <strong>{selected ? "✓" : "+"}</strong>
                </button>;
              })}
            </div>
            <p className={styles.helper}>{selectedPetIds.length}/4 pets selected. Multi-pet prices come from the governed catalogue.</p>
            {mixedAudience && <p className={styles.inlineError}>Dog and cat care cannot be mixed in one grooming booking. Create separate appointments for their safety.</p>}
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
          </section>

          <section className={styles.step}>
            <div className={styles.stepHead}><span>03</span><div><small>SERVICE DOORSTEP</small><h2>Where should we come?</h2></div></div>
            <div className={styles.addressBox}>
              <label><span>House, street & area</span><input value={address} onChange={e => { setAddress(e.target.value); invalidateDoorstep(); }} placeholder="e.g. 21, 18th Main, HSR Layout" /></label>
              <label className={styles.pinField}><span>PIN code</span><input inputMode="numeric" value={pincode} onChange={e => { setPincode(e.target.value.replace(/\D/g, "").slice(0, 6)); invalidateDoorstep(); }} placeholder="560102" /></label>
              <button onClick={() => void verifyCoverage()} disabled={coverageBusy || pincode.length !== 6}>{coverageBusy ? "Checking…" : "Verify doorstep"}</button>
            </div>
            {coverage && <div className={styles.coverageSuccess}><span>✓</span><div><b>{coverage.zoneName} is covered</b><small>{coverage.area}, {coverage.city} · {coverage.pincode}</small></div><strong>LIVE</strong></div>}
            {coverageError && <p className={styles.inlineError}>{coverageError}</p>}
          </section>

          <section className={styles.step}>
            <div className={styles.stepHead}><span>04</span><div><small>LIVE AVAILABILITY</small><h2>Pick a beautiful time</h2></div></div>
            <div className={styles.dateStrip}>{dates.map(item => <button key={item.isoDate} className={date === item.isoDate ? styles.dateSelected : ""} onClick={() => { invalidateCare(); setDate(item.isoDate); }}><small>{item.day}</small><b>{item.date}</b></button>)}</div>
            <div className={styles.slotGrid}>{SLOT_LABELS.map((label, index) => {
              const available = Boolean(bundle && date && groomingSlotAvailable(date, index, bundle.slotMinutes));
              return <button key={label} disabled={!available} className={slotIndex === index ? styles.slotSelected : ""} onClick={() => { invalidateCare(); setSlotIndex(index); }}><span>{label}</span><small>{available ? "Check live groomers" : "Unavailable"}</small></button>;
            })}</div>
            <button className={styles.liveButton} disabled={!bundle || !coverage || mixedAudience || providerBusy} onClick={() => void checkLiveCare()}><span>✦</span>{providerBusy ? "Checking PawSpace live…" : "Check live price & groomers"}</button>
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
            <div><span>Doorstep</span><b>{coverage ? `${coverage.area}, ${coverage.pincode}` : "Verify address"}</b></div>
            <div><span>When</span><b>{date ? `${date} · ${SLOT_LABELS[slotIndex]}` : "—"}</b></div>
            <div><span>Groomer</span><b>{providers?.providers.find(item => item.id === selectedProviderId)?.name || (providers ? "Choose groomer" : "Checked after slot")}</b></div>
          </div>
          <div className={styles.priceBlock}><span>{quote ? "Verified live price" : "Package price"}</span><b>{quote ? money(quote.price) : bundle ? money(bundle.price) : "—"}</b><small>{quote ? (quote.source === "pricing_control" ? "Confirmed from Pricing Control" : "Confirmed canonical package price") : "Final price checks your exact slot and zone"}</small></div>
          <div className={styles.safe}><span>◆</span><p><b>Nothing reserved yet.</b> Review your care details. The next step creates one booking; payment opens only after its doorstep is verified.</p></div>
          <button className={styles.continue} disabled={!quote || !coverage || !selectedProviderId || !scheduledStart || !scheduledEnd || checkoutBusy || providerBusy || mixedAudience} onClick={() => void beginSecureCheckout()}>{checkoutBusy ? "Reserving…" : "Reserve & review payment"} <span>→</span></button>
          {checkoutError && <p role="alert" className={styles.inlineError}>{checkoutError}</p>}
          <small className={styles.footnote}>Reservation and payment begin only after you press the secure checkout button.</small>
        </aside>
      </div>
    </main>
  );
}
