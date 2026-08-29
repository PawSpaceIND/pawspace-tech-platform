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

const VIDEO_SERVICE_CODES = ["grooming", "dog_training", "boarding", "pet_sitting", "dog_walking", "pet_taxi"];

const serviceShortCopy: Record<string, string> = {
  grooming: "Clean & fresh",
  dog_training: "Smart & confident",
  boarding: "Safe & comfortable",
  pet_sitting: "Care at home",
  dog_walking: "Daily exercise",
  pet_taxi: "Safe travel",
  food: "Fresh nutrition",
  relocation: "Travel support",
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
  const [pet, setPet] = useState<{ name: string; profile?: { photo?: string } } | null>(null);

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
      .then((body: { data?: { pets?: Array<{ name: string; profile?: { photo?: string } }> } }) => {
        if (active) setPet(body.data?.pets?.[0] ?? null);
      })
      .catch(() => { if (active) setPet(null); });
    return () => { active = false; };
  }, [customerId]);

  const visible = useMemo(
    () => services.filter((service) => `${service.name} ${service.subtitle}`.toLowerCase().includes(query.trim().toLowerCase())),
    [query, services],
  );
  const careServices = visible;
  const videoServices = services.filter((service) => VIDEO_SERVICE_CODES.includes(service.serviceCode));
  const heroService = services.find((service) => service.serviceCode === "grooming") ?? services[0];
  const petName = pet?.name || "your pet";
  const firstName = customerName?.split(" ")[0];

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

  return <div className={styles.home} data-discovery>
    <section className={styles.topShell}>
      <div className={styles.brandRow}>
        <img className={styles.brandLogo} src="/assets/pawspace-logo.jpeg" alt="PawSpace" />
        <button className={styles.profile} onClick={onShowPets} aria-label="Open pet profiles">
          {pet?.profile?.photo ? <img src={pet.profile.photo} alt={`${pet.name}'s profile`} /> : <span>PS</span>}
        </button>
      </div>

      <button className={styles.location} onClick={() => setLocationOpen(true)} aria-label="Choose your service location">
        <span className={styles.pin}>●</span><b>{location}</b><i>⌄</i>
      </button>

      <label className={styles.search}>
        <span>⌕</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search grooming, training, boarding..." aria-label="Search PawSpace services" />
      </label>
    </section>

    <section className={styles.hero}>
      <div className={styles.heroCopy}>
        {firstName && <small>GOOD TO SEE YOU, {firstName.toUpperCase()}</small>}
        <h1>What does <em>{pet?.name || "your pet"}</em> need today?</h1>
      </div>
      {heroService && <img src={heroService.image} alt={heroService.imageAlt} />}
      <span className={styles.heroPaw}>🐾</span>
    </section>

    <section className={styles.servicesSection}>
      <div className={styles.sectionHead}>
        <div><small>PAWSPACE CARE</small><h2>Everything they need</h2></div>
        <button onClick={() => setQuery("")}>View all</button>
      </div>

      <div className={styles.serviceGrid}>
        {careServices.map((service) => {
          const paused = disabledServices.has(service.serviceCode);
          return <button key={service.serviceCode} className={styles.serviceCard} onClick={() => onOpen(service.serviceCode)} disabled={paused}>
            <div className={styles.serviceVisual}><img src={service.image} alt={service.imageAlt} /></div>
            <span className={styles.serviceIcon}>✦</span>
            <strong>{service.name}</strong>
            <small>{paused ? "Temporarily paused" : serviceShortCopy[service.serviceCode] || service.subtitle}</small>
          </button>;
        })}
      </div>

      {visible.length === 0 && <p className={styles.empty}>No PawSpace service matches “{query}”.</p>}
    </section>

    <section className={styles.reminder}>
      <div className={styles.reminderCopy}>
        <span className={styles.reminderPaw}>🐾</span>
        <div><h3>{pet?.name ? `${pet.name} is due for grooming` : "A fresh grooming day"}</h3><p>Regular grooming keeps {petName} comfortable, healthy and happy.</p></div>
      </div>
      {heroService && <img src={heroService.image} alt="" />}
      <button onClick={() => onOpen("grooming")}>Book now</button>
    </section>

    <section className={styles.trustStrip} aria-label="PawSpace trust standards">
      <span><i>✓</i><b>Verified<br/>experts</b></span>
      <span><i>◇</i><b>Background<br/>checked</b></span>
      <span><i>✦</i><b>Hygiene<br/>assured</b></span>
      <span><i>◌</i><b>24/7<br/>support</b></span>
    </section>

    <section className={styles.servicesSection} aria-label="Quick service guides">
      <div className={styles.sectionHead}>
        <div><small>KNOW BEFORE YOU BOOK</small><h2>Quick service guides</h2></div>
      </div>
      <div className={styles.moreRail}>
        {videoServices.map((service) => {
          const paused = disabledServices.has(service.serviceCode);
          return <button key={`guide-${service.serviceCode}`} onClick={() => onOpen(service.serviceCode)} disabled={paused}>
            <span><img src={service.image} alt="" /></span>
            <div><b>{service.name}</b><small>{paused ? "Temporarily paused" : "1-min service guide"}</small></div>
            <i>▶</i>
          </button>;
        })}
      </div>
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
