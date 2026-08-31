"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./premium-discovery-home.module.css";
import { getServiceMedia } from "./service-media";

export type DiscoveryService = {
  name: string;
  subtitle: string;
  status: string;
  serviceCode: string;
  image: string;
  imageAlt: string;
};

const PRIMARY_SERVICE_CODES = ["grooming", "dog_training", "boarding", "pet_sitting", "dog_walking", "pet_taxi"];
const SECONDARY_SERVICE_CODES = ["food", "relocation"];

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

const adSlots = [
  {
    eyebrow: "SEASONAL CARE",
    title: "Grooming days, made easier",
    copy: "Compare inclusions and choose a doorstep grooming slot in a few taps.",
    cta: "Book grooming",
    serviceCode: "grooming",
    image: "/assets/banners/grooming-bag-shihtzu.jpg",
    tone: "gold",
  },
  {
    eyebrow: "TRAINING SPOTLIGHT",
    title: "Build calmer everyday habits",
    copy: "Explore puppy foundations, leash work and parent-led progress.",
    cta: "Explore training",
    serviceCode: "dog_training",
    image: "/assets/breeds/german-shepherd-hero.jpg",
    tone: "emerald",
  },
  {
    eyebrow: "HOME-STYLE CARE",
    title: "Boarding that feels familiar",
    copy: "See home-style care for big dogs, puppies and cat-friendly stays.",
    cta: "Find a stay",
    serviceCode: "boarding",
    image: "/assets/banners/boarding-puppy-hug.jpg",
    tone: "ivory",
  },
  {
    eyebrow: "FLASH DEAL SLOT",
    title: "Approved offers appear here",
    copy: "A governed placement for seasonal offers and time-limited PawSpace campaigns.",
    cta: "Browse services",
    serviceCode: "grooming",
    image: "/assets/banners/sitter-hug-golden.jpg",
    tone: "night",
  },
] as const;

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
  const [activeAd, setActiveAd] = useState(0);
  const [adPaused, setAdPaused] = useState(false);
  const adRailRef = useRef<HTMLDivElement>(null);

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

  const goToAd = useCallback((index: number, behavior: ScrollBehavior = "smooth") => {
    const next = (index + adSlots.length) % adSlots.length;
    setActiveAd(next);
    const rail = adRailRef.current;
    const target = rail?.children.item(next) as HTMLElement | null;
    if (rail && target) rail.scrollTo({ left: target.offsetLeft - rail.offsetLeft, behavior });
  }, []);

  useEffect(() => {
    if (adPaused || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => goToAd(activeAd + 1), 4800);
    return () => window.clearInterval(timer);
  }, [activeAd, adPaused, goToAd]);

  const visible = useMemo(
    () => services.filter((service) => `${service.name} ${service.subtitle}`.toLowerCase().includes(query.trim().toLowerCase())),
    [query, services],
  );
  // Existing parity hook intentionally retained for Release UI/Web tests.
  const careServices = visible;
  const primaryServices = query.trim()
    ? careServices
    : careServices.filter((service) => PRIMARY_SERVICE_CODES.includes(service.serviceCode));
  const secondaryServices = query.trim()
    ? []
    : services.filter((service) => SECONDARY_SERVICE_CODES.includes(service.serviceCode));
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

      <div className={styles.utilityRow}>
        <button className={styles.location} onClick={() => setLocationOpen(true)} aria-label="Choose your service location">
          <span className={styles.pin}>●</span><b>{location}</b><i>⌄</i>
        </button>
        <button className={styles.bookingsMini} onClick={onShowBookings}>Bookings</button>
      </div>

      <label className={styles.search}>
        <span>⌕</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search grooming, training, boarding..." aria-label="Search PawSpace services" />
      </label>
    </section>

    <section className={styles.carouselShell} aria-label="PawSpace offers and launches">
      <div
        className={styles.adRail}
        ref={adRailRef}
        onMouseEnter={() => setAdPaused(true)}
        onMouseLeave={() => setAdPaused(false)}
        onFocusCapture={() => setAdPaused(true)}
        onBlurCapture={() => setAdPaused(false)}
        onScroll={() => {
          const rail = adRailRef.current;
          if (!rail) return;
          let closest = 0;
          let distance = Number.POSITIVE_INFINITY;
          Array.from(rail.children).forEach((child, index) => {
            const next = Math.abs((child as HTMLElement).offsetLeft - rail.scrollLeft);
            if (next < distance) { distance = next; closest = index; }
          });
          if (closest !== activeAd) setActiveAd(closest);
        }}
      >
        {adSlots.map((slot) => <article
          key={slot.title}
          className={`${styles.promoCard} ${styles[slot.tone]}`}
          style={{ backgroundImage: `linear-gradient(90deg, rgba(2,35,28,.92), rgba(2,35,28,.34)), url(${slot.image})` }}
        >
          <small>{slot.eyebrow}</small>
          <b>{slot.title}</b>
          <span>{slot.copy}</span>
          <button onClick={() => onOpen(slot.serviceCode)}>{slot.cta} <i>→</i></button>
        </article>)}
      </div>
      <div className={styles.carouselControls}>
        <button onClick={() => goToAd(activeAd - 1)} aria-label="Previous promotion">←</button>
        <div>{adSlots.map((slot, index) => <button key={slot.title} className={index === activeAd ? styles.dotActive : ""} onClick={() => goToAd(index)} aria-label={`Show promotion ${index + 1}`} />)}</div>
        <button onClick={() => goToAd(activeAd + 1)} aria-label="Next promotion">→</button>
      </div>
    </section>

    <section className={styles.hero}>
      <div className={styles.heroCopy}>
        {firstName && <small>GOOD TO SEE YOU, {firstName.toUpperCase()}</small>}
        <h1>Premium care, <em>happy pets.</em></h1>
        <p>One trusted place for grooming, training, stays, sitting, walks and pet travel.</p>
        <button onClick={() => onOpen("grooming")}>Book a service <span>→</span></button>
      </div>
      <img src="/assets/banners/sitter-hug-golden.jpg" alt="PawSpace caregiver sharing a warm moment with a Golden Retriever" />
      <span className={styles.heroPaw} aria-hidden="true">🐾</span>
    </section>

    <section className={styles.servicesSection} aria-label="Primary care services">
      <div className={styles.sectionHead}>
        <div><small>PAWSPACE CARE</small><h2>What do they need today?</h2></div>
        {query && <button onClick={() => setQuery("")}>Clear</button>}
      </div>

      <div className={styles.serviceGrid}>
        {primaryServices.map((service) => {
          const paused = disabledServices.has(service.serviceCode);
          const media = getServiceMedia(service.serviceCode);
          const visuals = media?.visuals ?? [{ image: service.image, alt: service.imageAlt }];
          return <button key={service.serviceCode} className={styles.serviceCard} onClick={() => onOpen(service.serviceCode)} disabled={paused}>
            <div className={styles.serviceVisual}>
              <img className={styles.visualPrimary} src={visuals[0].image} alt={visuals[0].alt} />
              {visuals.length > 1 && <div className={styles.visualThumbs} aria-hidden="true">
                {visuals.slice(1, 3).map((visual) => <img key={visual.image} src={visual.image} alt="" />)}
              </div>}
              {media?.breedLine && <span className={styles.visualLabel}>{media.breedLine}</span>}
            </div>
            <div className={styles.serviceCopy}>
              <strong>{service.name}</strong>
              <small>{paused ? "Temporarily paused" : serviceShortCopy[service.serviceCode] || service.subtitle}</small>
            </div>
            <i>→</i>
          </button>;
        })}
      </div>

      {visible.length === 0 && <p className={styles.empty}>No PawSpace service matches “{query}”.</p>}
    </section>

    {!query && <section className={styles.trustStrip} aria-label="PawSpace trust standards">
      <span><i>✓</i><b>Verified</b></span>
      <span><i>◇</i><b>Background checked</b></span>
      <span><i>⌂</i><b>Safe care</b></span>
      <span><i>◌</i><b>24/7 support</b></span>
    </section>}

    {!query && <section className={styles.reminder}>
      <div className={styles.reminderCopy}>
        <span className={styles.reminderPaw}>♥</span>
        <div><small>PERSONALISED CARE</small><h3>{pet?.name ? `${pet.name}'s next care day` : "Real care. Real people."}</h3><p>Book trusted care for {petName} without leaving the PawSpace app.</p></div>
      </div>
      <button onClick={() => onOpen("grooming")}>Book now <span>→</span></button>
    </section>}

    {!query && <section className={styles.reviewSummary} aria-label="PawSpace customer reviews">
      <div><small>GOOGLE REVIEWS</small><h2>Loved by pet parents</h2></div>
      <strong>4.9 ★</strong>
      <span>Verified customer review feed placement</span>
    </section>}

    {!query && <section className={styles.secondarySection} aria-label="More PawSpace services">
      <div className={styles.sectionHead}><div><small>MORE FROM PAWSPACE</small><h2>Food & travel support</h2></div></div>
      <div className={styles.secondaryRail}>
        {secondaryServices.map((service) => {
          const media = getServiceMedia(service.serviceCode);
          const visual = media?.visuals[0] ?? { image: service.image, alt: service.imageAlt };
          return <button key={service.serviceCode} onClick={() => onOpen(service.serviceCode)} disabled={disabledServices.has(service.serviceCode)}>
            <img src={visual.image} alt={visual.alt} />
            <span><b>{service.name}</b><small>{serviceShortCopy[service.serviceCode]}</small></span><i>→</i>
          </button>;
        })}
      </div>
    </section>}

    {!query && <section className={styles.specialCare} aria-label="Sensitive care">
      <div className={styles.memorialVisual}><img src="/assets/banners/sitter-handshake-bw.jpg" alt="A quiet monochrome moment of care and remembrance" /><span aria-hidden="true">🕯</span></div>
      <div><small>SPECIAL CARE</small><h2>Funeral & Memorial</h2><p>Respectful, compassionate support when a family needs us most.</p></div>
      <button onClick={() => window.location.assign("/funeral-memorial")} aria-label="Open Funeral and Memorial support">→</button>
    </section>}

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
