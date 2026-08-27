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
  Grooming: { image: "/assets/breeds/shih-tzu-hero.jpg", alt: "Shih tzu ready for grooming", headline: "Doorstep grooming, beautifully simple", sub: "Choose care, time and preferences in one place" },
  Training: { image: "/assets/breeds/german-shepherd-hero.jpg", alt: "German Shepherd in training", headline: "Structured training, visible progress", sub: "Build everyday skills, session by session" },
  Boarding: { image: "/assets/breeds/golden-retriever-hero.jpg", alt: "Golden Retriever ready for boarding", headline: "Home boarding with thoughtful checks", sub: "Stay details, care preferences and updates together" },
  "Pet Sitting": { image: "/assets/breeds/labrador-retriever-hero.jpg", alt: "Labrador Retriever receiving care at home", headline: "Care in your own home", sub: "A care plan built around your pet" },
  "Dog Walking": { image: "/assets/banners/walking-husky-forest.jpg", alt: "A large dog enjoying a guided walk", headline: "Big walks with a clear plan", sub: "Scheduled walks, live updates and familiar routines" },
  "Pet Taxi": { image: "/assets/banners/taxi-car-window.jpg", alt: "Dog looking out of a pet taxi window", headline: "A calmer way to travel together", sub: "Trip details, handover updates and care information in one place" },
  "Fresh Food": { image: "/assets/banners/food-prep-bowl.jpg", alt: "Fresh pet food being prepared", headline: "Fresh meals, simply ordered", sub: "Explore the catalogue, delivery choices and order updates" },
  Relocation: { image: "/assets/banners/taxi-vintage-truck.jpg", alt: "Pet travel crate ready for relocation", headline: "Thoughtful support for every move", sub: "Share your plan and let the PawSpace team guide the details" },
};

const HOME_BANNER: BannerSpec = { image: "/assets/banners/grooming-bag-shihtzu.jpg", alt: "Freshly groomed shih tzu in a PawSpace bag", headline: "PawSpace care in one family record", sub: "Provider details · service updates · one family record" };

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
        <li>✓ Verification status shown explicitly</li>
        <li>✓ Updates reflect the active service workflow</li>
        <li>✓ Invoices follow recorded payment status</li>
        <li>✓ Cancellation terms shown per service</li>
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
