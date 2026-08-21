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
  Grooming: { image: "/assets/banners/grooming-groomer-action.jpg", alt: "PawSpace groomer bathing a dog", headline: "Doorstep grooming, clearly booked", sub: "Provider status · package details · canonical booking updates" },
  Training: { image: "/assets/banners/training-handshake.jpg", alt: "Trainer teaching a dog to shake hands", headline: "Structured training, visible progress", sub: "Governed programmes · session-by-session records" },
  Boarding: { image: "/assets/banners/boarding-puppy-hug.jpg", alt: "Host hugging a boarding puppy", headline: "Home boarding with explicit checks", sub: "Host verification status · capacity · stay records" },
  "Pet Sitting": { image: "/assets/banners/sitting-woman-cat.jpg", alt: "Pet sitter caring for a cat at home", headline: "Care in your own home", sub: "Provider details · care plan · visit records" },
  "Dog Walking": { image: "/assets/banners/walking-husky-forest.jpg", alt: "Dog walker with a husky", headline: "Scheduled walks with clear status", sub: "Canonical schedule · walker assignment · evidence status" },
  "Pet Taxi": { image: "/assets/banners/taxi-car-window.jpg", alt: "Dog looking out of a pet taxi window", headline: "Pet transport, clearly governed", sub: "Driver assignment · handover record · trip status" },
  "Fresh Food": { image: "/assets/banners/food-prep-bowl.jpg", alt: "Fresh pet food being prepared", headline: "Pet food orders with explicit status", sub: "Catalogue details · stock status · order record" },
  Relocation: { image: "/assets/banners/taxi-vintage-truck.jpg", alt: "Pet travel crate ready for relocation", headline: "Relocation requests reviewed carefully", sub: "Requirements · document status · human confirmation" },
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
