"use client";
/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from "react";
import styles from "./service-banner.module.css";
import { getServiceMediaByName, getServiceVideoUrl } from "./service-media";
import ServiceHero from "./service-hero";
import { SERVICE_ART } from "./service-art";

const HOME_BANNER = {
  image: "/assets/banners/sitter-hug-golden.jpg",
  alt: "PawSpace caregiver with a happy pet",
  headline: "Real care. Real people.",
  sub: "One familiar PawSpace experience across every service",
  review: "PawSpace care details",
};

export default function ServiceBanner({ service, compact }: { service?: string; compact?: boolean }) {
  const media = getServiceMediaByName(service);
  const [visualSelection, setVisualSelection] = useState<{ service?: string; index: number }>({ service, index: 0 });
  const [videoFailed, setVideoFailed] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(true);
  const [videoInView, setVideoInView] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const videoPreviewRef = useRef<HTMLElement>(null);
  const videoSrc = media ? getServiceVideoUrl(media.serviceCode) : null;
  const activeVisual = visualSelection.service === service ? visualSelection.index : 0;
  const safeVisualIndex = media ? Math.min(activeVisual, media.visuals.length - 1) : 0;
  const serviceArt = media ? SERVICE_ART[media.serviceCode] : undefined;
  const mainVisual = (safeVisualIndex === 0 ? serviceArt : undefined) ?? media?.visuals[safeVisualIndex] ?? { image: HOME_BANNER.image, alt: HOME_BANNER.alt };
  const headline = media?.headline ?? HOME_BANNER.headline;
  const sub = media?.sub ?? HOME_BANNER.sub;
  const review = service ? `Care details · ${service}` : HOME_BANNER.review;
  const breedOptions = media?.breedLine.split(" · ") ?? [];
  const supportsIntersectionObserver = typeof window !== "undefined" && "IntersectionObserver" in window;
  const videoVisibleEnough = supportsIntersectionObserver ? videoInView : typeof window !== "undefined";
  const canAutoplayVideo = Boolean(media && videoSrc && !videoFailed && !reducedMotion && videoVisibleEnough && pageVisible);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const target = videoPreviewRef.current;
    if (!target) return;
    if (!supportsIntersectionObserver) return;
    const observer = new IntersectionObserver(([entry]) => {
      setVideoInView(entry.isIntersecting && entry.intersectionRatio >= 0.35);
    }, { threshold: [0, 0.35, 1] });
    observer.observe(target);
    return () => observer.disconnect();
  }, [service, supportsIntersectionObserver]);

  useEffect(() => {
    const sync = () => setPageVisible(!document.hidden);
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  if (compact && service) return <ServiceHero service={service} />;

  return (
    <section className={`${styles.banner} ${compact ? styles.compact : ""}`} aria-label={`${service ?? "PawSpace"} highlights`}>
      <div className={styles.adSlot}><small>PAWSPACE CARE GUIDE</small><b>Get to know your pet’s care</b></div>
      <figure>
        <div className={styles.visualStack}>
          <img className={styles.heroImage} src={mainVisual.image} alt={mainVisual.alt} loading="lazy" />
          {media && media.visuals.length > 1 && <div className={styles.visualThumbs} aria-label={`${service} curated visual examples`}>
            {media.visuals.map((visual, index) => <button
              type="button"
              key={visual.image}
              className={index === safeVisualIndex ? styles.visualThumbActive : ""}
              onClick={() => setVisualSelection({ service, index })}
              aria-label={`Show ${breedOptions[index] ?? media.serviceName} visual`}
              aria-pressed={index === safeVisualIndex}
            ><img src={visual.image} alt={visual.alt} loading="lazy" /></button>)}
          </div>}
          {media?.breedLine && <div className={styles.breedLine} aria-label={`${service} curated breed and service visuals`}>
            {breedOptions.map((label, index) => <button
              type="button"
              key={label}
              className={`${styles.breedChip} ${index === safeVisualIndex ? styles.breedChipActive : ""}`}
              onClick={() => setVisualSelection({ service, index })}
              aria-pressed={index === safeVisualIndex}
            >{label}</button>)}
          </div>}
        </div>
        <figcaption>
          {safeVisualIndex === 0 && serviceArt?.illustrated && <small>AI service illustration · not your assigned caregiver</small>}
          <h3>{headline}</h3>
          <p>{sub}</p>
        </figcaption>
      </figure>

      <ul className={styles.trust}>
        <li>✓ Verification status shown explicitly</li>
        <li>✓ Clear service inclusions</li>
        <li>✓ Cancellation terms shown per service</li>
      </ul>

      {media && <section ref={videoPreviewRef} className={styles.videoPreview} aria-label={`${service} video preview`}>
        {canAutoplayVideo ? <video muted autoPlay loop playsInline preload="metadata" poster={media.videoPoster} onError={() => setVideoFailed(true)}>
          <source src={videoSrc ?? undefined} type="video/mp4" />
          Your browser does not support embedded video.
        </video> : <div className={styles.videoPoster} style={{ backgroundImage: `linear-gradient(90deg,rgba(1,38,31,.82),rgba(1,38,31,.28)),url(${media.videoPoster})` }}>
          <i aria-hidden="true">▶</i>
          <span>
            <small>HD SERVICE PREVIEW</small>
            <b>{media.videoTitle}</b>
            <em>{videoFailed ? "Premium poster fallback" : reducedMotion ? "Still preview for reduced-motion preference" : videoSrc ? "Film plays silently while visible" : "Premium poster shown until approved footage is published"}</em>
          </span>
        </div>}
      </section>}

      <div className={styles.reviews} aria-label={review}>
        <div><b>Care you can understand</b></div>
        <p>Compare what is included, share your pet’s needs and review the details before booking.</p>
      </div>
    </section>
  );
}
