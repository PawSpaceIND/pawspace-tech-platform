"use client";
/* eslint-disable @next/next/no-img-element */
// Two premium home screens for founder review, from the shared reference sheet:
//
//   "premium"  = Option 5 (Premium & Visual) — dark emerald ground, gold CTAs, full-photo service
//                cards. Reads as a luxury service brand.
//   "calm"     = Option 1 (Clean & Calm)     — ivory ground, white cards, photo + inclusion list
//                per service. Reads as clear, trustworthy and easy.
//
// Both render the SAME real data (live offers, the customer's real next booking, the real service
// list with its real availability state) and open the SAME booking flows — the difference is
// presentation only, so a choice between them is a choice about design, not about behaviour.
import { useState } from "react";
import styles from "./home-designs.module.css";

export type HomeDesignId = "premium" | "calm";
export const HOME_DESIGN_STORAGE_KEY = "pawspace.customer.homeDesign";
export const DEFAULT_HOME_DESIGN: HomeDesignId = "premium";
export function isHomeDesignId(value: string | null | undefined): value is HomeDesignId {
  return value === "premium" || value === "calm";
}

export type HomeService = { name: string; icon: string; subtitle: string; serviceCode: string; status: string };
export type HomeBooking = { id: string; serviceCode: string; packageName: string; scheduledStart: string; status: string } | null;
export type HomeOffer = { code: string; description: string; autoApply: boolean };
export type HomeCampaign = { eyebrow: string; title: string; copy: string; cta: string; kind: string };

// Real photography per service, from the same library the service banners use.
const PHOTO: Record<string, string> = {
  Grooming: "/assets/banners/grooming-groomer-action.jpg",
  Training: "/assets/banners/training-handshake.jpg",
  Boarding: "/assets/banners/boarding-puppy-hug.jpg",
  "Pet Sitting": "/assets/banners/sitting-woman-cat.jpg",
  "Pet Taxi": "/assets/banners/taxi-car-window.jpg",
  "Dog Walking": "/assets/banners/walking-husky-forest.jpg",
  "Fresh Food": "/assets/banners/food-prep-bowl.jpg",
  Relocation: "/assets/banners/taxi-vintage-truck.jpg",
};
// One-line promise per service — what the customer actually gets, no puffery.
const PROMISE: Record<string, string> = {
  Grooming: "Salon-grade care at home",
  Training: "Build better behaviour",
  Boarding: "A safe & happy stay",
  "Pet Sitting": "Lovingly cared at home",
  "Pet Taxi": "Comfortable & safe rides",
  "Dog Walking": "Daily walks for a healthy dog",
  "Fresh Food": "Healthy meals for pets",
  Relocation: "We handle the journey",
};
const INCLUSIONS: Record<string, string[]> = {
  Grooming: ["Bath & blow dry", "Haircut & styling", "Nail trimming", "Ear cleaning"],
  Training: ["Puppy training", "Basic obedience", "Behaviour support", "Progress report card"],
  Boarding: ["24/7 supervision", "Home-checked hosts", "Daily photo updates", "Vet-ready protocols"],
  "Pet Sitting": ["In-home care", "Feeding & playtime", "Litter / potty", "Photo updates"],
  "Pet Taxi": ["Trained drivers", "Crate-secured", "Vet visits", "Live trip status"],
  "Dog Walking": ["GPS-logged route", "Fixed walker", "30 / 45 / 60 min", "Photo proof"],
  "Fresh Food": ["Vet-formulated", "Human-grade", "Fresh batches", "Doorstep delivery"],
  Relocation: ["Domestic & international", "Airline paperwork", "IATA crates", "Door-to-door"],
};

const CTA: Record<string, string> = { "Fresh Food": "Order Now", Relocation: "Enquire Now" };
const cta = (name: string) => CTA[name] || "Book Now";

const when = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
};
const title = (code: string) => code.replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase());

type HomeProps = {
  design: HomeDesignId;
  services: HomeService[];
  disabledServices: Set<string>;
  open: (service: HomeService) => void;
  greetingName: string | null;
  locationLabel: string;
  offers: HomeOffer[];
  nextBooking: HomeBooking;
  onSearch: (term: string) => void;
  onOpenBookings: () => void;
  campaigns: HomeCampaign[];
  onCampaign: (kind: string) => void;
};

/** The shared top bar: location, profile, search — identical data, styled per design. */
function TopBar({ locationLabel, greetingName, onSearch }: { locationLabel: string; greetingName: string | null; onSearch: (term: string) => void }) {
  const [term, setTerm] = useState("");
  return (
    <header className={styles.top}>
      <div className={styles.topRow}>
        <div className={styles.place}>
          <i aria-hidden="true">◉</i>
          <div>
            <b>{locationLabel.split(",")[0] || "Bengaluru"}</b>
            <small>{locationLabel.includes(",") ? locationLabel.split(",").slice(1).join(",").trim() : "Tap to set your exact address"}</small>
          </div>
        </div>
        <span className={styles.avatar} aria-hidden="true">{(greetingName || "P").slice(0, 1).toUpperCase()}</span>
      </div>
      {greetingName && <p className={styles.greeting}>Good day, {greetingName.split(" ")[0]}</p>}
      <form
        className={styles.search}
        onSubmit={event => { event.preventDefault(); if (term.trim()) onSearch(term.trim()); }}
      >
        <i aria-hidden="true">⌕</i>
        <input value={term} onChange={event => setTerm(event.target.value)} placeholder="Search grooming, boarding, taxi…" aria-label="Search PawSpace services" />
      </form>
    </header>
  );
}

function QuickGrid({ services, disabledServices, open }: { services: HomeService[]; disabledServices: Set<string>; open: (s: HomeService) => void }) {
  return (
    <nav className={styles.quickGrid} aria-label="All services">
      {services.map(service => {
        const off = disabledServices.has(service.serviceCode);
        return (
          <button key={service.name} type="button" onClick={() => open(service)} disabled={off} className={off ? styles.quickOff : undefined}>
            <span className={styles.quickPhoto}><img src={PHOTO[service.name]} alt="" loading="lazy" /></span>
            <b>{service.name}</b>
            {off && <small>Paused</small>}
          </button>
        );
      })}
    </nav>
  );
}

function NextBooking({ booking, onOpenBookings }: { booking: HomeBooking; onOpenBookings: () => void }) {
  if (!booking) return null;
  return (
    <section className={styles.upcoming} aria-label="Upcoming booking">
      <div>
        <small>UPCOMING BOOKING</small>
        <b>{booking.packageName || title(booking.serviceCode)}</b>
        <span>{when(booking.scheduledStart)} · {booking.status.replaceAll("_", " ")}</span>
      </div>
      <button type="button" onClick={onOpenBookings}>View all</button>
    </section>
  );
}

function OfferStrip({ offers }: { offers: HomeOffer[] }) {
  if (!offers.length) return null;
  return (
    <div className={styles.offers} aria-label="Available offers">
      {offers.slice(0, 4).map(offer => (
        <span key={offer.code} className={styles.offerChip}>
          <b>{offer.code}</b>
          <small>{offer.description}</small>
          {offer.autoApply && <em>Auto-applies</em>}
        </span>
      ))}
    </div>
  );
}

function MediaSlot({ campaigns, onCampaign }: { campaigns: HomeCampaign[]; onCampaign: (kind: string) => void }) {
  const [index, setIndex] = useState(0);
  if (!campaigns.length) return null;
  const item = campaigns[Math.min(index, campaigns.length - 1)];
  return (
    <section className={styles.media} aria-label="Featured promotion">
      <div className={styles.mediaHead}>
        <span>{item.eyebrow}</span>
        <em>{index + 1}/{campaigns.length}</em>
      </div>
      <h3>{item.title}</h3>
      <p>{item.copy}</p>
      <button type="button" onClick={() => onCampaign(item.kind)}>{item.cta}</button>
      <div className={styles.mediaDots}>
        {campaigns.map((campaign, dot) => (
          <button key={campaign.title} type="button" aria-label={`Show campaign ${dot + 1}`} aria-current={dot === index} className={dot === index ? styles.dotOn : undefined} onClick={() => setIndex(dot)} />
        ))}
      </div>
      <small className={styles.mediaDisclosure}>PawSpace Media slot · service education and clearly labelled approved campaigns</small>
    </section>
  );
}

export default function HomeDesign(props: HomeProps) {
  const { design, services, disabledServices, open, offers, nextBooking, onOpenBookings, campaigns, onCampaign } = props;
  const hero = design === "premium"
    ? { photo: "/assets/banners/sitter-hug-golden.jpg", eyebrow: "PREMIUM CARE", headline: "Premium care for your loved ones", copy: "Book trusted, background-verified services across Bengaluru." }
    : { photo: "/assets/banners/grooming-bag-shihtzu.jpg", eyebrow: "WHY PAWSPACE", headline: "Care that comes home to them", copy: "Trusted by pet parents across Bengaluru." };

  return (
    <div className={`${styles.home} ${design === "premium" ? styles.premium : styles.calm}`} data-home-design={design}>
      <TopBar {...props} />

      <section className={styles.hero}>
        <img src={hero.photo} alt="" loading="lazy" />
        <div className={styles.heroCopy}>
          <small>{hero.eyebrow}</small>
          <h2>{hero.headline}</h2>
          <p>{hero.copy}</p>
          <button type="button" onClick={() => open(services[0])}>{cta(services[0]?.name || "")}</button>
        </div>
      </section>

      <OfferStrip offers={offers} />
      <MediaSlot campaigns={campaigns} onCampaign={onCampaign} />
      <QuickGrid services={services} disabledServices={disabledServices} open={open} />
      <NextBooking booking={nextBooking} onOpenBookings={onOpenBookings} />

      <h3 className={styles.sectionHead}>All 8 services</h3>
      <div className={styles.cards}>
        {services.map(service => {
          const off = disabledServices.has(service.serviceCode);
          return (
            <article key={service.name} className={styles.card}>
              <div className={styles.cardPhoto}>
                <img src={PHOTO[service.name]} alt={`PawSpace ${service.name}`} loading="lazy" />
                {design === "premium" && (
                  <div className={styles.cardOverlay}>
                    <b>{service.name}</b>
                    <small>{PROMISE[service.name]}</small>
                  </div>
                )}
              </div>
              <div className={styles.cardBody}>
                {design === "calm" && (
                  <>
                    <b>{service.name}</b>
                    <small>{PROMISE[service.name]}</small>
                    <ul>{(INCLUSIONS[service.name] || []).map(item => <li key={item}>{item}</li>)}</ul>
                  </>
                )}
                <button type="button" onClick={() => open(service)} disabled={off}>
                  {off ? "Currently paused" : cta(service.name)}
                </button>
              </div>
            </article>
          );
        })}
      </div>

      <ul className={styles.assurance}>
        <li><b>Verified & trusted</b><small>Background-checked professionals</small></li>
        <li><b>Safety & comfort first</b><small>Protocols on every visit</small></li>
        <li><b>Real-time updates</b><small>Photos and status as it happens</small></li>
        <li><b>GST invoice</b><small>On every completed service</small></li>
      </ul>
    </div>
  );
}

/** Founder review control: flip between the two designs live, on device. */
export function HomeDesignSwitcher({ design, choose }: { design: HomeDesignId; choose: (design: HomeDesignId) => void }) {
  return (
    <section className={styles.switcher} aria-label="Home screen design">
      <div>
        <span>HOME DESIGN · REVIEW</span>
        <h3>Two premium directions</h3>
        <p>Same data, same flows — presentation only. Pick one and it is remembered on this device.</p>
      </div>
      <div className={styles.switchRow}>
        <button type="button" aria-pressed={design === "premium"} className={design === "premium" ? styles.switchOn : undefined} onClick={() => choose("premium")}>
          <b>Option 5 · Premium &amp; Visual</b>
          <small>Dark emerald, gold CTAs, full-photo cards</small>
        </button>
        <button type="button" aria-pressed={design === "calm"} className={design === "calm" ? styles.switchOn : undefined} onClick={() => choose("calm")}>
          <b>Option 1 · Clean &amp; Calm</b>
          <small>Ivory, white cards, inclusions listed</small>
        </button>
      </div>
    </section>
  );
}
