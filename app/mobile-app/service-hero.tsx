"use client";
/* eslint-disable @next/next/no-img-element */
// Shared Option 5 service-page anatomy recovered from PR #148. This is presentation-only:
// every service keeps its current booking flow, APIs and business logic underneath this hero.
import styles from "./service-hero.module.css";
import { SERVICE_ART } from "./service-art";
import { getServiceMediaByName } from "./service-media";

type HeroSpec = { photo: string; alt: string; badge: string; promise: string; proofs: [string, string, string] };

const HERO: Record<string, HeroSpec> = {
  Grooming: {
    photo: "/assets/pawspace-doorstep.png", alt: "PawSpace grooming care in a pet family's home", badge: "✁",
    promise: "Salon-grade grooming at home", proofs: ["Coat care", "At home", "Gentle handling"],
  },
  Training: {
    photo: "/assets/pawspace-home.png", alt: "Pet parent and Golden Retriever at home", badge: "◎",
    promise: "Build everyday confidence together", proofs: ["Positive methods", "Structured", "Report card"],
  },
  Boarding: {
    photo: "/assets/banners/boarding-puppy-hug.jpg", alt: "Host hugging a boarding puppy", badge: "⌂",
    promise: "Verified homes, not cages", proofs: ["Host home", "Care routine", "Stay updates"],
  },
  "Pet Sitting": {
    photo: "/assets/banners/sitting-woman-cat.jpg", alt: "Pet sitter caring for a cat at home", badge: "♡",
    promise: "Loving care in your own home", proofs: ["Trusted sitters", "Care plan", "Every visit logged"],
  },
  "Dog Walking": {
    photo: "/assets/banners/walking-husky-forest.jpg", alt: "Dog walker with a husky on a forest trail", badge: "◌",
    promise: "Walks they'll wait at the door for", proofs: ["Doorstep pickup", "Walk routine", "Booking updates"],
  },
  "Pet Taxi": {
    photo: "/assets/banners/taxi-car-window.jpg", alt: "Dog looking out of a pet taxi window", badge: "⇥",
    promise: "Safe rides, door to door", proofs: ["Trained drivers", "Crate-secured", "Live status"],
  },
  "Fresh Food": {
    photo: "/assets/banners/food-prep-bowl.jpg", alt: "Fresh pet food being prepared", badge: "❋",
    promise: "Fresh meals, thoughtfully prepared", proofs: ["Meal choices", "Portion details", "Delivery plan"],
  },
  Relocation: {
    photo: "/assets/banners/taxi-vintage-truck.jpg", alt: "Pet travel crate ready for relocation", badge: "✈",
    promise: "Domestic & international moves", proofs: ["Airline paperwork", "IATA crates", "Door-to-door"],
  },
};

export default function ServiceHero({ service }: { service: string }) {
  const spec = HERO[service];
  if (!spec) return null;
  const media = getServiceMediaByName(service);
  const art = media ? SERVICE_ART[media.serviceCode] : undefined;
  return (
    <section className={styles.hero} aria-label={`${service} overview`} data-service-design="option-5-premium-visual">
      <div className={styles.photo}>
        <img src={art?.image ?? spec.photo} alt={art?.alt ?? spec.alt} loading="lazy" />
        {art?.illustrated && <small className={styles.artNote}>AI service illustration · not your assigned caregiver</small>}
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
