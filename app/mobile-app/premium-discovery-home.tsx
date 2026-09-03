"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "./premium-discovery-home.module.css";

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
  { eyebrow: "PAWSPACE OFFER", title: "Complete grooming, clearly compared", copy: "See every inclusion before you choose a dog or cat package.", cta: "Compare packages", serviceCode: "grooming" },
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
  const [locationOpen, setLocationOpen] = useState(false);
  const [location, setLocation] = useState("HSR Layout, Bengaluru");
  const [draft, setDraft] = useState("");
  const [locationNote, setLocationNote] = useState("");
  const [campaignIndex, setCampaignIndex] = useState(0);
  const [pet, setPet] = useState<CustomerPet | null>(null);
  const [offers, setOffers] = useState<CustomerOffer[]>([]);
  const [nextBooking, setNextBooking] = useState<CustomerBooking | null>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem("pawspace_discovery_location");
    if (!stored) return;
    const timer = window.setTimeout(() => setLocation(stored), 0);
    return () => window.clearTimeout(timer);
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

  const saveLocation = (value: string) => {
    const next = value.trim();
    if (!next) return;
    setLocation(next);
    window.localStorage.setItem("pawspace_discovery_location", next);
    setLocationOpen(false);
    setLocationNote("");
  };

  const useDeviceLocation = () => {
    if (!navigator.geolocation) {
      setLocationNote("Location access is unavailable here. Enter your area instead.");
      return;
    }
    setLocationNote("Finding your location...");
    navigator.geolocation.getCurrentPosition(
      () => saveLocation("Current location"),
      () => setLocationNote("We could not access your location. Enter your area instead."),
      { timeout: 8000, maximumAge: 300000 },
    );
  };

  return <div className={styles.home} data-discovery data-home-design="option-5-premium-visual">
    <header className={styles.top}>
      <div className={styles.topRow}>
        <button className={styles.location} onClick={() => setLocationOpen(true)} aria-label="Choose your service location">
          <i aria-hidden="true">●</i>
          <span><b>{location.split(",")[0]}</b><small>{location.includes(",") ? location.split(",").slice(1).join(",").trim() : "Tap to set your exact address"}</small></span>
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
      <img src="/assets/banners/sitter-hug-golden.jpg" alt="PawSpace caregiver with a Golden Retriever" />
      <div className={styles.heroCopy}>
        <small>PREMIUM CARE</small>
        <h1>Premium care for your loved ones</h1>
        <p>Book trusted, background-verified services across Bengaluru.</p>
        <button onClick={() => onOpen("grooming")}>Book now</button>
      </div>
    </section>

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
          <span><img src={PHOTO[service.serviceCode] || service.image} alt="" /></span><b>{service.name}</b>
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
          return <article className={styles.card} key={service.serviceCode}>
            <div className={styles.cardPhoto}>
              <img src={PHOTO[service.serviceCode] || service.image} alt={`PawSpace ${service.name}`} />
              <div><b>{service.name}</b><small>{PROMISE[service.serviceCode] || service.subtitle}</small></div>
            </div>
            <button onClick={() => onOpen(service.serviceCode)} disabled={paused}>{paused ? "Currently paused" : cta(service.serviceCode)}</button>
          </article>;
        })}
      </div>
      {visible.length === 0 && <p className={styles.empty}>No PawSpace service matches “{query}”.</p>}
    </section>

    <section className={styles.assurance} aria-label="PawSpace trust standards">
      <article><b>Verified & trusted</b><small>Background-checked professionals</small></article>
      <article><b>Safety & comfort first</b><small>Protocols on every visit</small></article>
      <article><b>Real-time updates</b><small>Photos and status as it happens</small></article>
      <article><b>GST invoice</b><small>On every completed service</small></article>
    </section>

    <button className={styles.bookingShortcut} onClick={onShowBookings}>View your bookings <span>→</span></button>

    {locationOpen && <div className={styles.sheetBackdrop} role="presentation" onMouseDown={() => setLocationOpen(false)}>
      <section className={styles.sheet} role="dialog" aria-modal="true" aria-label="Choose PawSpace service location" onMouseDown={(event) => event.stopPropagation()}>
        <div className={styles.handle} />
        <small>PAWSPACE LOCATION</small><h2>Where should we care for your pet?</h2>
        <p>We will use this to show the right availability when you book.</p>
        <button className={styles.deviceLocation} onClick={useDeviceLocation}>⌖ Use my current location</button>
        <label><span>Area, city or pincode</span><input autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="e.g. HSR Layout, Bengaluru" /></label>
        {locationNote && <p className={styles.locationNote}>{locationNote}</p>}
        <button className={styles.saveLocation} onClick={() => saveLocation(draft)}>Save location</button>
      </section>
    </div>}
  </div>;
}
