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

const sponsoredOffers = [
  { tag: "SPONSORED PREVIEW", title: "The road is yours", copy: "A premium drive companion placement for pet-friendly journeys.", tone: "drive" },
  { tag: "LOCAL FAVOURITE", title: "Dinner for you. Treats for them.", copy: "A pet-welcoming restaurant offer near your next walk.", tone: "dine" },
];

const communityCards = [
  { icon: "⌂", title: "Apartment offers", copy: "Bring PawSpace care to your community." },
  { icon: "♥", title: "Adopt & foster", copy: "Make room for a new best friend." },
  { icon: "✦", title: "Pet events", copy: "Meet-ups, parties and play dates nearby." },
];

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
  const [location, setLocation] = useState("Choose location");
  const [draft, setDraft] = useState("");
  const [locationNote, setLocationNote] = useState("");
  const [pet, setPet] = useState<{ name: string; profile?: { photo?: string } } | null>(null);
  const [activeOffer, setActiveOffer] = useState(0);
  const [videoGuide, setVideoGuide] = useState<DiscoveryService | null>(null);

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
    () => services.filter((service) => `${service.name} ${service.subtitle}`.toLowerCase().includes(query.toLowerCase())),
    [query, services],
  );
  const primaryServices = visible.filter((service) => ["grooming", "dog_training", "boarding", "pet_sitting", "dog_walking", "pet_taxi"].includes(service.serviceCode));

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
    setLocationNote("Finding your location…");
    navigator.geolocation.getCurrentPosition(
      () => saveLocation("Current location"),
      () => setLocationNote("We could not access your location. Enter your area instead."),
      { timeout: 8000, maximumAge: 300000 },
    );
  };

  const greeting = pet?.name ? `A great day for ${pet.name}` : customerName ? `Hi, ${customerName.split(" ")[0]}` : "Care that feels personal";

  return <div className={styles.home} data-discovery>
    <header className={styles.header}>
      <button className={styles.location} onClick={() => setLocationOpen(true)} aria-label="Choose your service location">
        <img className={styles.brandLogo} src="/assets/pawspace-logo.jpeg" alt="PawSpace" />
        <span className={styles.pin}>⌖</span>
        <span><small>DELIVERING PET CARE TO</small><b>{location}</b></span>
        <i>⌄</i>
      </button>
      <button className={styles.profile} onClick={onShowPets} aria-label="Open pet profiles">{pet?.profile?.photo ? <img src={pet.profile.photo} alt={`${pet.name}'s profile`} /> : "🐾"}</button>
    </header>

    <section className={styles.hero}>
      <div>
        <span>PAWSPACE CARE</span>
        <h1>{greeting}.</h1>
        <p>One trusted place for every walk, stay, session and grooming day.</p>
      </div>
      <div className={styles.pawMark}>✦</div>
    </section>

    <label className={styles.search}>
      <span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="What does your pet need today?" aria-label="Search PawSpace services" />
    </label>

    <section className={`${styles.sponsored} ${styles[sponsoredOffers[activeOffer].tone]}`} aria-label="Sponsored offer">
      <div><small>{sponsoredOffers[activeOffer].tag}</small><h2>{sponsoredOffers[activeOffer].title}</h2><p>{sponsoredOffers[activeOffer].copy}</p><button type="button" onClick={() => setActiveOffer((activeOffer + 1) % sponsoredOffers.length)}>See offer <b>→</b></button></div>
      <div className={styles.offerArt} aria-hidden>{activeOffer === 0 ? "✧" : "✦"}</div>
      <div className={styles.offerDots}>{sponsoredOffers.map((offer, index) => <button key={offer.title} aria-label={`Show ${offer.title}`} className={index === activeOffer ? styles.selectedOffer : ""} onClick={() => setActiveOffer(index)} />)}</div>
    </section>

    <section className={styles.quick}>
      <div className={styles.sectionHead}><div><small>BOOK IN A FEW TAPS</small><h2>Care for every kind of day</h2></div><button onClick={onShowBookings}>Your bookings →</button></div>
      <div className={styles.grid}>
        {primaryServices.map((service) => {
          const paused = disabledServices.has(service.serviceCode);
          return <button key={service.serviceCode} className={styles.serviceCard} onClick={() => onOpen(service.serviceCode)} disabled={paused}>
            <img src={service.image} alt={service.imageAlt} />
            <span className={styles.imageWash} />
            <div><em>{paused ? "PAUSED" : service.status}</em><strong>{service.name}</strong><small>{service.subtitle}</small></div>
          </button>;
        })}
      </div>
      {primaryServices.length === 0 && <p className={styles.empty}>No care service matches “{query}”.</p>}
    </section>

    <section className={styles.videoSection}>
      <div className={styles.sectionHead}><div><small>HOW PAWSPACE WORKS</small><h2>Watch before you book</h2></div><span>Swipe →</span></div>
      <div className={styles.videoRail}>
        {primaryServices.map((service) => <button className={styles.videoCard} key={service.serviceCode} onClick={() => setVideoGuide(service)}>
          <img src={service.image} alt="" /><span className={styles.videoWash} /><i>▶</i><div><small>{service.name.toUpperCase()}</small><b>{service.name} guide</b></div>
        </button>)}
      </div>
    </section>

    <section className={styles.featured}>
      <img src="/assets/breeds/shih-tzu-hero.jpg" alt="A shih tzu ready for grooming" />
      <div><span>PAWSPACE FAVOURITE</span><h2>Grooming that comes to you</h2><p>Choose a package, pick a time and keep care details in one place.</p><button onClick={() => onOpen("grooming")}>Explore grooming <b>→</b></button></div>
    </section>

    <section className={styles.trust}>
      <div><span>✦</span><p><b>{pet?.profile?.photo ? `${pet.name}'s photo is on your profile.` : "Care details stay connected."}</b> {pet?.profile?.photo ? "It can become their personalised PawSpace artwork with your permission." : "Add your pet’s photo to make this space feel like theirs."}</p></div>
      <button onClick={onShowPets}>Meet your pets →</button>
    </section>

    <section className={styles.community}>
      <div className={styles.sectionHead}><div><small>PAWSPACE COMMUNITY</small><h2>More good around your pet</h2></div><span>Local</span></div>
      <div className={styles.communityRail}>{communityCards.map((card) => <article key={card.title}><i>{card.icon}</i><b>{card.title}</b><p>{card.copy}</p><span>Coming soon</span></article>)}</div>
    </section>

    {videoGuide && <div className={styles.sheetBackdrop} role="presentation" onMouseDown={() => setVideoGuide(null)}>
      <section className={styles.videoSheet} role="dialog" aria-modal="true" aria-label={`${videoGuide.name} video guide`} onMouseDown={(event) => event.stopPropagation()}>
        <button aria-label="Close video guide" onClick={() => setVideoGuide(null)}>×</button><img src={videoGuide.image} alt={videoGuide.imageAlt} /><div><small>PAWSPACE VIDEO GUIDE</small><h2>{videoGuide.name} in a minute</h2><p>This card is ready for the approved service video. Until PawSpace uploads the real guide, we show the service journey instead of pretending a video is available.</p><button onClick={() => onOpen(videoGuide.serviceCode)}>Explore {videoGuide.name} →</button></div>
      </section>
    </div>}

    {locationOpen && <div className={styles.sheetBackdrop} role="presentation" onMouseDown={() => setLocationOpen(false)}>
      <section className={styles.sheet} role="dialog" aria-modal="true" aria-label="Choose PawSpace service location" onMouseDown={(event) => event.stopPropagation()}>
        <div className={styles.handle} />
        <small>PAWSPACE LOCATION</small><h2>Where should we care for your pet?</h2>
        <p>We’ll use this to show the right availability when you book.</p>
        <button className={styles.deviceLocation} onClick={useDeviceLocation}>⌖ Use my current location</button>
        <label><span>Area, city or pincode</span><input autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="e.g. HSR Layout, Bengaluru" /></label>
        {locationNote && <p className={styles.locationNote}>{locationNote}</p>}
        <button className={styles.saveLocation} onClick={() => saveLocation(draft)}>Save location</button>
      </section>
    </div>}
  </div>;
}
