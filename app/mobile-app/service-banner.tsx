"use client";
/* eslint-disable @next/next/no-img-element */
import { useState } from "react";
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
  const [videoOpen, setVideoOpen] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const videoSrc = media ? getServiceVideoUrl(media.serviceCode) : null;
  const mainVisual = media?.visuals[0] ?? { image: HOME_BANNER.image, alt: HOME_BANNER.alt };
  const headline = media?.headline ?? HOME_BANNER.headline;
  const sub = media?.sub ?? HOME_BANNER.sub;
  const review = service ? `Google review carousel · ${service}` : HOME_BANNER.review;

  return (
    <section className={`${styles.banner} ${compact ? styles.compact : ""}`} aria-label={`${service ?? "PawSpace"} highlights`}>
      <div className={styles.adSlot}><small>PAWSPACE MEDIA</small><b>Offer / education / partner placement</b></div>
      <figure>
        <div className={styles.visualStack}>
          <img className={styles.heroImage} src={mainVisual.image} alt={mainVisual.alt} loading="lazy" />
          {media && media.visuals.length > 1 && <div className={styles.visualThumbs} aria-label={`${service} visual examples`}>
            {media.visuals.slice(1, 3).map((visual) => <img key={visual.image} src={visual.image} alt={visual.alt} loading="lazy" />)}
          </div>}
          {media?.breedLine && <span className={styles.breedLine}>{media.breedLine}</span>}
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

      {media && <section className={styles.videoPreview} aria-label={`${service} video preview`}>
        {videoOpen && videoSrc && !videoFailed ? <video controls autoPlay playsInline preload="metadata" poster={media.videoPoster} onError={() => setVideoFailed(true)}>
          <source src={videoSrc} type="video/mp4" />
          Your browser does not support embedded video.
        </video> : <button type="button" className={styles.videoPoster} onClick={() => setVideoOpen(true)} aria-expanded={videoOpen} style={{ backgroundImage: `linear-gradient(90deg,rgba(1,38,31,.82),rgba(1,38,31,.28)),url(${media.videoPoster})` }}>
          <i>▶</i>
          <span>
            <small>HD DOORSTEP PREVIEW</small>
            <b>{media.videoTitle}</b>
            <em>{videoSrc ? "Tap to play" : "Approved film slot ready for the PawSpace media CDN"}</em>
          </span>
        </button>}
        {videoOpen && (!videoSrc || videoFailed) && <p className={styles.videoNote}>The UI is ready for the approved real-service film. Playback activates when <code>NEXT_PUBLIC_PAWSPACE_SERVICE_VIDEO_BASE</code> points to the published HD media library.</p>}
      </section>}

      <div className={styles.reviews} aria-label={review}>
        <div><b>4.9 ★</b><span>Google Reviews</span></div>
        <p>{review}</p>
        <small>Scroll recent verified customer feedback here</small>
      </div>
    </section>
  );
}
