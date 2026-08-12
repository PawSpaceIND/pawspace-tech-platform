"use client";
/* eslint-disable @next/next/no-img-element */
// Premium trust banner rendered at the top of every service booking screen (and reusable on Home).
// Real photography from /assets/banners (groomers at work, boarding cuddles, walkers, taxi, food
// prep) + a trust strip + an honest video slot: the play card is a labelled placeholder until real
// footage is produced — it never fakes a video that does not exist.
import { useState } from "react";
import styles from "./service-banner.module.css";

type BannerSpec = { image: string; alt: string; headline: string; sub: string };

const BANNERS: Record<string, BannerSpec> = {
  Grooming: { image: "/assets/banners/grooming-groomer-action.jpg", alt: "PawSpace groomer bathing a dog", headline: "Salon-grade grooming, at home", sub: "Background-verified groomers · own equipment · live photo updates" },
  Training: { image: "/assets/banners/training-handshake.jpg", alt: "Trainer teaching a dog to shake hands", headline: "Certified trainers, visible progress", sub: "Structured programmes · session-by-session report card" },
  Boarding: { image: "/assets/banners/boarding-puppy-hug.jpg", alt: "Host hugging a boarding puppy", headline: "Verified homes, not cages", sub: "Home-checked hosts · daily photos · vet-ready protocols" },
  "Pet Sitting": { image: "/assets/banners/sitting-woman-cat.jpg", alt: "Pet sitter caring for a cat at home", headline: "Care in your own home", sub: "Trusted sitters · care-plan driven · every visit logged" },
  "Dog Walking": { image: "/assets/banners/walking-husky-forest.jpg", alt: "Dog walker with a husky", headline: "Walks they'll wait at the door for", sub: "GPS-logged routes · fixed walker · photo proof per walk" },
  "Pet Taxi": { image: "/assets/banners/taxi-car-window.jpg", alt: "Dog looking out of a pet taxi window", headline: "Safe rides, door to door", sub: "Trained drivers · crate-secured · live trip status" },
  "Fresh Food": { image: "/assets/banners/food-prep-bowl.jpg", alt: "Fresh pet food being prepared", headline: "Fresh-cooked, vet-formulated", sub: "Small batches · species-appropriate · doorstep delivery" },
  Relocation: { image: "/assets/banners/taxi-vintage-truck.jpg", alt: "Pet travel crate ready for relocation", headline: "Domestic & international moves", sub: "Airline paperwork · IATA crates · door-to-door tracking" },
};

const HOME_BANNER: BannerSpec = { image: "/assets/banners/grooming-bag-shihtzu.jpg", alt: "Freshly groomed shih tzu in a PawSpace bag", headline: "India's most caring pet app", sub: "Verified professionals · live updates · one family record" };

export default function ServiceBanner({ service, compact }: { service?: string; compact?: boolean }) {
  const spec = (service && BANNERS[service]) || HOME_BANNER;
  const [videoOpen, setVideoOpen] = useState(false);
  return (
    <section className={`${styles.banner} ${compact ? styles.compact : ""}`} aria-label={`${service ?? "PawSpace"} highlights`}>
      <figure>
        <img src={spec.image} alt={spec.alt} loading="lazy" />
        <figcaption>
          <h3>{spec.headline}</h3>
          <p>{spec.sub}</p>
        </figcaption>
      </figure>
      <ul className={styles.trust}>
        <li>✓ Verified &amp; background-checked</li>
        <li>✓ Live photo updates</li>
        <li>✓ GST invoice on every order</li>
        <li>✓ 100% refund policy</li>
      </ul>
      {!compact && (
        <button type="button" className={styles.video} onClick={() => setVideoOpen(value => !value)} aria-expanded={videoOpen}>
          <i>▶</i>
          <span>
            <b>Watch how {service ? `${service.toLowerCase()} works` : "PawSpace works"}</b>
            <small>{videoOpen ? "Filming in progress — this slot plays the real service video once produced. No stock footage, only our own team." : "60-second walkthrough · tap to preview slot"}</small>
          </span>
        </button>
      )}
    </section>
  );
}
