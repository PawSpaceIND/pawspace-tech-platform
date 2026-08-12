"use client";
/* eslint-disable @next/next/no-img-element */
// Service-page hero, built to the shared reference: full-bleed photograph, then a card lifting over
// it carrying a round service badge, the service name, a one-line promise and the three trust
// proofs that matter for THAT service. Rendered at the top of every one of the eight booking flows,
// so all service pages share one premium anatomy instead of eight different headers.
import styles from "./service-hero.module.css";

type HeroSpec = { photo: string; alt: string; badge: string; promise: string; proofs: [string, string, string] };

const HERO: Record<string, HeroSpec> = {
  Grooming: {
    photo: "/assets/banners/grooming-groomer-action.jpg", alt: "PawSpace groomer bathing a dog", badge: "✁",
    promise: "Salon-grade grooming at home", proofs: ["Verified groomers", "Own equipment", "Stress-free"],
  },
  Training: {
    photo: "/assets/banners/training-handshake.jpg", alt: "Trainer teaching a dog to shake hands", badge: "◎",
    promise: "Certified trainers, real progress", proofs: ["Positive methods", "Structured", "Report card"],
  },
  Boarding: {
    photo: "/assets/banners/boarding-puppy-hug.jpg", alt: "Host hugging a boarding puppy", badge: "⌂",
    promise: "Verified homes, not cages", proofs: ["Home-checked", "Daily photos", "Vet-ready"],
  },
  "Pet Sitting": {
    photo: "/assets/banners/sitting-woman-cat.jpg", alt: "Pet sitter caring for a cat at home", badge: "♡",
    promise: "Loving care in your own home", proofs: ["Trusted sitters", "Care plan", "Every visit logged"],
  },
  "Dog Walking": {
    photo: "/assets/banners/walking-husky-forest.jpg", alt: "Dog walker with a husky on a forest trail", badge: "◌",
    promise: "Walks they'll wait at the door for", proofs: ["GPS-tracked", "Fixed walker", "Photo proof"],
  },
  "Pet Taxi": {
    photo: "/assets/banners/taxi-car-window.jpg", alt: "Dog looking out of a pet taxi window", badge: "⇥",
    promise: "Safe rides, door to door", proofs: ["Trained drivers", "Crate-secured", "Live status"],
  },
  "Fresh Food": {
    photo: "/assets/banners/food-prep-bowl.jpg", alt: "Fresh pet food being prepared", badge: "❋",
    promise: "Fresh-cooked, vet-formulated", proofs: ["Human-grade", "Small batches", "Delivered fresh"],
  },
  Relocation: {
    photo: "/assets/banners/taxi-vintage-truck.jpg", alt: "Pet travel crate ready for relocation", badge: "✈",
    promise: "Domestic & international moves", proofs: ["Airline paperwork", "IATA crates", "Door-to-door"],
  },
};

export default function ServiceHero({ service }: { service: string }) {
  const spec = HERO[service];
  if (!spec) return null;
  return (
    <section className={styles.hero} aria-label={`${service} overview`}>
      <div className={styles.photo}>
        <img src={spec.photo} alt={spec.alt} loading="lazy" />
      </div>
      <div className={styles.card}>
        <span className={styles.badge} aria-hidden="true">{spec.badge}</span>
        <div className={styles.copy}>
          <h2>{service}</h2>
          <p>{spec.promise}</p>
          <ul>
            {spec.proofs.map(proof => <li key={proof}>{proof}</li>)}
          </ul>
        </div>
      </div>
    </section>
  );
}
