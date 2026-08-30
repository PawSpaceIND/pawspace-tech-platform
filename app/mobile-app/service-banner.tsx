"use client";
/* eslint-disable @next/next/no-img-element */
import { useState } from "react";
import styles from "./service-banner.module.css";

type BannerSpec = { image: string; alt: string; headline: string; sub: string; review: string };

const BANNERS: Record<string, BannerSpec> = {
  Grooming: { image: "/assets/banners/grooming-groomer-action.jpg", alt: "PawSpace groomer caring for a dog", headline: "Grooming with a human touch", sub: "Expert hands, calm care and a cleaner booking flow", review: "Google review carousel · Grooming" },
  Training: { image: "/assets/banners/training-handshake.jpg", alt: "PawSpace trainer working with a dog and pet parent", headline: "Training built around real families", sub: "Clear programmes, visible progress and parent participation", review: "Google review carousel · Training" },
  Boarding: { image: "/assets/banners/sitter-hug-golden.jpg", alt: "Female home host caring for a Golden Retriever", headline: "A home stay, not a cage", sub: "Comfort, trusted hosts and room to feel at home", review: "Google review carousel · Boarding" },
  "Pet Sitting": { image: "/assets/banners/sitting-woman-cat.jpg", alt: "Female pet sitter caring for a cat at home", headline: "Care that comes home", sub: "A familiar environment with a trusted sitter", review: "Google review carousel · Pet Sitting" },
  "Dog Walking": { image: "/assets/banners/walking-leash-city.jpg", alt: "Dog walker taking a pet on a neighbourhood walk", headline: "Happy walks with people you can trust", sub: "Simple scheduling, familiar routines and clear updates", review: "Google review carousel · Dog Walking" },
  "Pet Taxi": { image: "/assets/banners/taxi-car-window.jpg", alt: "Pet travelling safely inside a car", headline: "Safe travel for pets and parents", sub: "Pickup, handover and trip details in one place", review: "Google review carousel · Pet Taxi" },
  "Fresh Food": { image: "/assets/banners/food-prep-pouring.jpg", alt: "Fresh pet food being prepared by hand", headline: "Fresh food made with care", sub: "Explore meals, delivery choices and order updates", review: "Google review carousel · Fresh Food" },
  Relocation: { image: "/assets/banners/taxi-vintage-truck.jpg", alt: "Pet travel and relocation support", headline: "Relocation with calm, guided support", sub: "Domestic and international move assistance from one place", review: "Google review carousel · Relocation" },
};

const HOME_BANNER: BannerSpec = { image: "/assets/banners/sitter-hug-golden.jpg", alt: "PawSpace caregiver with a happy pet", headline: "Real care. Real people.", sub: "One familiar PawSpace experience across every service", review: "Google review carousel" };

export default function ServiceBanner({ service, compact }: { service?: string; compact?: boolean }) {
  const spec = (service && BANNERS[service]) || HOME_BANNER;
  const [videoOpen, setVideoOpen] = useState(false);
  return (
    <section className={`${styles.banner} ${compact ? styles.compact : ""}`} aria-label={`${service ?? "PawSpace"} highlights`}>
      <div className={styles.adSlot}><small>PAWSPACE MEDIA</small><b>Offer / education / partner placement</b></div>
      <figure>
        <img src={spec.image} alt={spec.alt} loading="lazy" />
        <figcaption>
          <h3>{spec.headline}</h3>
          <p>{spec.sub}</p>
        </figcaption>
      </figure>
      <ul className={styles.trust}>
        <li>✓ Verification status shown explicitly</li>
        <li>✓ Clear service inclusions</li>
        <li>✓ Cancellation terms shown per service</li>
      </ul>
      <button type="button" className={styles.video} onClick={() => setVideoOpen(value => !value)} aria-expanded={videoOpen}>
        <i>▶</i>
        <span>
          <b>{service ? `${service} video` : "PawSpace service video"}</b>
          <small>{videoOpen ? "Video placeholder ready for the approved PawSpace service film." : "60-second service guide · video slot"}</small>
        </span>
      </button>
      <div className={styles.reviews} aria-label={spec.review}>
        <div><b>4.9 ★</b><span>Google Reviews</span></div>
        <p>{spec.review}</p>
        <small>Scroll recent verified customer feedback here</small>
      </div>
    </section>
  );
}
