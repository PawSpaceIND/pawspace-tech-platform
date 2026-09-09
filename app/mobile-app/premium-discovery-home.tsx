"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./premium-discovery-home.module.css";
import { SERVICE_ART } from "./service-art";
import LocationWelcome, { DISCOVERY_PIN_KEY, WELCOME_SEEN_KEY } from "./location-welcome";
import { resolveServiceCoverage, type ResolvedServiceCoverage } from "../../lib/service-zone-client";

export type DiscoveryService = {
  name: string;
  subtitle: string;
  status: string;
  serviceCode: string;
  image: string;
  imageAlt: string;
};

type CustomerPet = { name: string; profile?: { photo?: string } };
type CustomerBooking = { id: string; serviceCode: string; packageName: string; scheduledStart: string; status: string };
type CustomerOffer = { code: string; description: string; autoApply: boolean };

const VIDEO_SERVICE_CODES = ["grooming", "dog_training", "boarding", "pet_sitting", "dog_walking", "pet_taxi"];

const PHOTO: Record<string, string> = {
  grooming: "/assets/banners/grooming-groomer-action.jpg",
  dog_training: "/assets/banners/training-handshake.jpg",
  boarding: "/assets/banners/boarding-puppy-hug.jpg",
  pet_sitting: "/assets/banners/sitting-woman-cat.jpg",
  pet_taxi: "/assets/banners/taxi-car-window.jpg",
  dog_walking: "/assets/banners/walking-husky-forest.jpg",
  food: "/assets/banners/food-prep-bowl.jpg",
  relocation: "/assets/banners/taxi-vintage-truck.jpg",
};

const PROMISE: Record<string, string> = {
  grooming: "Salon-grade care at home",
  dog_training: "Build better behaviour",
  boarding: "A safe & happy stay",
  pet_sitting: "Lovingly cared for at home",
  pet_taxi: "Comfortable & safe rides",
  dog_walking: "Daily walks for a healthy dog",
  food: "Healthy meals for pets",
  relocation: "We handle the journey",
};

const CAMPAIGNS = [
  { eyebrow: "CARE GUIDE", title: "Complete grooming, clearly compared", copy: "See every inclusion before you choose a dog or cat package.", cta: "Compare packages", serviceCode: "grooming" },
  { eyebrow: "TRAINING GUIDE", title: "Better walks start at home", copy: "Explore how PawSpace trainers build calm leash habits together with pet parents.", cta: "Explore training", serviceCode: "dog_training" },
  { eyebrow: "PAWSPACE MEDIA", title: "Your neighbourhood, pet-ready", copy: "Service education and approved local PawSpace campaigns appear here.", cta: "Browse services", serviceCode: "grooming" },
] as const;

const cta = (serviceCode: string) => serviceCode === "food" ? "Order now" : serviceCode === "relocation" ? "Enquire now" : "Book now";

const when = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
};

export default function PremiumDiscoveryHome({
  services,
  disabledServices,
  customerName,
  customerId,
  onOpen,
  onShowBookings,
  onShowPets,
}: {
  services: DiscoveryService[];
  disabledServices: Set<string>;
  customerName?: string;
  customerId?: string;
  onOpen: (serviceCode: string) => void;
  onShowBookings: () => void;
  onShowPets: () => void;
}) {
  const [query, setQuery] = useState("");
  const locationDialog = useRef<HTMLDialogElement>(null);
  const [location, setLocation] = useState("Choose your area");
  const [showWelcome, setShowWelcome] = useState<boolean | null>(null);
  const [editingLocation, setEditingLocation] = useState(false);
  const [campaignIndex, setCampaignIndex] = useState(0);
  const [pet, setPet] = useState<CustomerPet | null>(null);
  const [offers, setOffers] = useState<CustomerOffer[]>([]);
  const [nextBooking, setNextBooking] = useState<CustomerBooking | null>(null);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      let seen = false, pin: string | null = null;
      try { seen = sessionStorage.getItem(WELCOME_SEEN_KEY) === "1"; pin = sessionStorage.getItem(DISCOVERY_PIN_KEY); } catch { /* Optional device preference. */ }
      setShowWelcome(!seen);
      if (pin && /^[1-9]\d{5}$/.test(pin)) void resolveServiceCoverage(pin, AbortSignal.timeout(10000)).then(coverage => {
        if (active) setLocation(`${coverage.area}, ${coverage.city}`);
      }).catch(() => { /* Never trust a stale stored city as verified coverage. */ });
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, []);

  useEffect(() => {
    if (!customerId) return;
    let active = true;
    void fetch(`/api/customer-account?customerId=${encodeURIComponent(customerId)}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((body: { data?: { pets?: CustomerPet[]; bookings?: CustomerBooking[] } }) => {
        if (!active) return;
        setPet(body.data?.pets?.[0] ?? null);
        const terminal = new Set(["completed", "cancelled", "refunded"]);
        const upcoming = (body.data?.bookings ?? [])
          .filter((booking) => !terminal.has(booking.status) && new Date(booking.scheduledStart).getTime() >= Date.now())
          .sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart));
        setNextBooking(upcoming[0] ?? null);
      })
      .catch(() => { if (active) { setPet(null); setNextBooking(null); } });
    void fetch(`/api/customer-offers?customerId=${encodeURIComponent(customerId)}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((body: { data?: { coupons?: CustomerOffer[] } }) => { if (active) setOffers(body.data?.coupons ?? []); })
      .catch(() => { if (active) setOffers([]); });
    return () => { active = false; };
  }, [customerId]);

  const visible = useMemo(
    () => services.filter((service) => `${service.name} ${service.subtitle}`.toLowerCase().includes(query.trim().toLowerCase())),
    [query, services],
  );
  const careServices = visible;
  const videoServices = services.filter((service) => VIDEO_SERVICE_CODES.includes(service.serviceCode));
  const campaign = CAMPAIGNS[campaignIndex];
  const customerInitial = customerName?.trim().slice(0, 1).toUpperCase() || "P";

  const useCoverage = (coverage: ResolvedServiceCoverage | null) => {
    setLocation(coverage ? `${coverage.area}, ${coverage.city}` : "Choose your area");
    setShowWelcome(false);
  };

  if (showWelcome === null) return <p role="status">Preparing your PawSpace…</p>;
  if (showWelcome) return <LocationWelcome onContinue={useCoverage} />;

  return <div className={styles.home} data-discovery data-home-design="option-5-premium-visual">
    <header className={styles.top}>
      <a className={styles.brand} href="/mobile-app"><img src="/assets/pawspace-logo.jpeg" alt="" /><b>PawSpace</b><small>Your Petter half</small></a>
      <div className={styles.topRow}>
        <button className={styles.location} onClick={() => { setEditingLocation(true); locationDialog.current?.showModal(); }} aria-label="Choose your service location">
          <i aria-hidden="true">●</i>
          <span><b>Care at · {location.split(",")[0]}</b><small>{location.includes(",") ? location.split(",").slice(1).join(",").trim() : "Choose your neighbourhood"}</small></span>
        </button>
        <button className={styles.avatar} onClick={onShowPets} aria-label="Open pet profiles">
          {pet?.profile?.photo ? <img src={pet.profile.photo} alt={`${pet.name}'s profile`} /> : customerInitial}
        </button>
      </div>
      {customerName && <p className={styles.greeting}>Good day, {customerName.split(" ")[0]}</p>}
      <label className={styles.search}>
        <i aria-hidden="true">⌕</i>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search grooming, boarding, taxi…" aria-label="Search PawSpace services" />
      </label>
    </header>

    <section className={styles.hero}>
      <img src="/assets/banners/sitter-hug-golden.jpg" alt="PawSpace caregiver with a Golden Retriever" fetchPriority="high" />
      <div className={styles.heroCopy}>
        <small>{pet ? `CARE FOR ${pet.name.toUpperCase()}` : "PREMIUM CARE"}</small>
        <h1>Premium care for your loved ones</h1>
        <p>{pet ? `What does ${pet.name} need today? Trusted PawSpace care is ready when you are.` : "Book trusted, background-verified pet care across Bengaluru."}</p>
        <button onClick={() => onOpen("grooming")}>Book now</button>
      </div>
    </section>

    {pet && <section className={styles.personalHero} aria-label="Your pet family">
      <div><small>YOUR PETTER HALF</small><h2>{pet.name}’s care, all in one place.</h2><button onClick={onShowPets}>Your pet family <span aria-hidden="true">↗</span></button></div>
      <button className={styles.petPortrait} onClick={onShowPets} aria-label={`Open ${pet.name}'s profile`}>
        {pet.profile?.photo ? <img src={pet.profile.photo} alt={pet.name} /> : <span aria-hidden="true">🐾</span>}
      </button>
    </section>}

    {offers.length > 0 && <section className={styles.offers} aria-label="Available offers">
      {offers.slice(0, 4).map((offer) => <article key={offer.code}>
        <b>{offer.code}</b><small>{offer.description}</small>{offer.autoApply && <em>Auto-applies</em>}
      </article>)}
    </section>}

    <section className={styles.media} aria-label="Featured promotion">
      <div><span>{campaign.eyebrow}</span><em>{campaignIndex + 1}/{CAMPAIGNS.length}</em></div>
      <h2>{campaign.title}</h2>
      <p>{campaign.copy}</p>
      <button onClick={() => onOpen(campaign.serviceCode)}>{campaign.cta}</button>
      <nav aria-label="Choose featured promotion">
        {CAMPAIGNS.map((item, index) => <button key={item.title} aria-label={`Show campaign ${index + 1}`} aria-current={index === campaignIndex} className={index === campaignIndex ? styles.dotOn : ""} onClick={() => setCampaignIndex(index)} />)}
      </nav>
      <small>PawSpace Media slot · service education and clearly labelled approved campaigns</small>
    </section>

    <section className={styles.quickSection} aria-label="Quick service guides">
      <h2>Explore quickly</h2>
      <div className={styles.quickGrid}>
        {videoServices.map((service) => <button key={service.serviceCode} onClick={() => onOpen(service.serviceCode)} disabled={disabledServices.has(service.serviceCode)}>
          <span><img src={PHOTO[service.serviceCode] || SERVICE_ART[service.serviceCode]?.image || service.image} alt="" /></span><b>{service.name}</b>
        </button>)}
      </div>
    </section>

    {nextBooking && <section className={styles.upcoming} aria-label="Upcoming booking">
      <div><small>UPCOMING BOOKING</small><b>{nextBooking.packageName || nextBooking.serviceCode.replaceAll("_", " ")}</b><span>{when(nextBooking.scheduledStart)} · {nextBooking.status.replaceAll("_", " ")}</span></div>
      <button onClick={onShowBookings}>View all</button>
    </section>}

    <section className={styles.care} aria-label="Care services">
      <div className={styles.sectionHead}><small>ALL 8 SERVICES</small><h2>Everything they need</h2></div>
      <div className={styles.cards}>
        {careServices.map((service) => {
          const paused = disabledServices.has(service.serviceCode);
          const featured = ["grooming", "dog_training"].includes(service.serviceCode);
          const symbols: Record<string, string> = { grooming: "✂", dog_training: "◎", boarding: "⌂", pet_sitting: "♡", pet_taxi: "↗", dog_walking: "🐾", food: "◒", relocation: "✈" };
          return <article className={`${styles.card} ${featured ? styles.featured : styles.compact}`} data-service={service.serviceCode} key={service.serviceCode}>
            <div className={styles.cardPhoto}>
              <img src={SERVICE_ART[service.serviceCode]?.image || service.image} alt={SERVICE_ART[service.serviceCode]?.alt || service.imageAlt} width="96" height="96" loading="lazy" /><span className={styles.serviceIcon} aria-hidden="true">{symbols[service.serviceCode] || "♡"}</span>
              <div><b>{service.name}</b><small>{PROMISE[service.serviceCode] || service.subtitle}</small></div>
            </div>
            <button aria-label={`${cta(service.serviceCode)} · ${service.name}`} onClick={() => onOpen(service.serviceCode)} disabled={paused}>{paused ? "Currently paused" : <><span className={styles.ctaLabel}>{cta(service.serviceCode)}</span><span aria-hidden="true">↗</span></>}</button>
          </article>;
        })}
      </div>
      {visible.length === 0 && <p className={styles.empty}>No PawSpace service matches “{query}”.</p>}
      <p className={styles.artDisclosure}>AI service illustrations. Caregiver profiles are shown separately after assignment.</p>
    </section>

    <section className={styles.assurance} aria-label="PawSpace trust standards">
      <article><b>Verified & trusted</b><small>Background-checked professionals</small></article>
      <article><b>Safety & comfort first</b><small>Protocols on every visit</small></article>
      <article><b>Real-time updates</b><small>Photos and status as it happens</small></article>
      <article><b>GST invoice</b><small>On every completed service</small></article>
    </section>

    <button className={styles.bookingShortcut} onClick={onShowBookings}>View your bookings <span>→</span></button>

    <dialog ref={locationDialog} className={styles.sheet} aria-label="Choose your service area" onClose={() => setEditingLocation(false)}>
      <div className={styles.sheetBackdrop}>
        <div className={styles.handle} aria-hidden="true" />
        <div className={styles.sheetHead}><small>CARE NEAR YOU</small><button aria-label="Close location" onClick={() => locationDialog.current?.close()}>×</button></div>
        <p className={styles.locationNote}>Availability is shown only after PawSpace verifies the entered service area.</p>
        <p className={styles.deviceLocation}>Verified pincode coverage · no guessed neighbourhood availability</p>
        {editingLocation && <LocationWelcome compact onContinue={coverage => { useCoverage(coverage); locationDialog.current?.close(); }} />}
        <button className={styles.saveLocation} onClick={() => locationDialog.current?.close()}>Done</button>
      </div>
    </dialog>
  </div>;
}
