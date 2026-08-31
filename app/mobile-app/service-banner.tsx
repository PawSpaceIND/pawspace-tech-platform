"use client";
/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from "react";
import styles from "./service-banner.module.css";
import { getServiceMediaByName, getServiceVideoUrl } from "./service-media";

const HOME_BANNER = {
  image: "/assets/banners/sitter-hug-golden.jpg",
  alt: "PawSpace caregiver with a happy pet",
  headline: "Real care. Real people.",
  sub: "One familiar PawSpace experience across every service",
  review: "Google review carousel",
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
  const mainVisual = media?.visuals[safeVisualIndex] ?? { image: HOME_BANNER.image, alt: HOME_BANNER.alt };
  const headline = media?.headline ?? HOME_BANNER.headline;
  const sub = media?.sub ?? HOME_BANNER.sub;
  const review = service ? `Google review carousel · ${service}` : HOME_BANNER.review;
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

  return (
    <section className={`${styles.banner} ${compact ? styles.compact : ""}`} aria-label={`${service ?? "PawSpace"} highlights`}>
      <div className={styles.adSlot}><small>PAWSPACE MEDIA</small><b>Offer / education / partner placement</b></div>
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
        <div><b>4.9 ★</b><span>Google Reviews</span></div>
        <p>{review}</p>
        <small>Scroll recent verified customer feedback here</small>
      </div>
    </section>
  );
}
