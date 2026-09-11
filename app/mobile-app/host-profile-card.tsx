"use client";
// Standalone, self-contained host/sitter profile card - deliberately does not import anything from
// any other in-flight booking-flow stream's files. Renders /api/host-profile data (demo/UAT
// profiles, see lib/host-profiles.ts). No real media assets: photoRef/housePhotoRefs are
// media-by-reference placeholder strings, rendered here as initials/emoji tiles, never an image tag.
import { useEffect, useState } from "react";
import styles from "./host-profile-card.module.css";

type HostProfileReview = { author: string; city: string; stars: number; text: string };
type HostProfileStats = { happyPets: number; onTimePct: number; happyParents: number; yearsExp: number };
type HostProfileVerification = { kyc: boolean; backgroundCheck: boolean; homeVerified: boolean };

type HostProfile = {
  providerId: string;
  displayName: string;
  role: "Host" | "Sitter";
  photoRef: string;
  housePhotoRefs: string[];
  verified: HostProfileVerification;
  rating: number;
  locationLabel: string;
  yearsExperience: number;
  about: string;
  specializations: string[];
  servicesOffered: string[];
  reviews: HostProfileReview[];
  stats: HostProfileStats;
};

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] || "";
  const second = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return `${first}${second}`.toUpperCase() || "🐾";
}

function stars(count: number) {
  const full = Math.round(Math.max(0, Math.min(5, count)));
  return "★".repeat(full) + "☆".repeat(5 - full);
}

export default function HostProfileCard({ providerId }: { providerId: string }) {
  const [profile, setProfile] = useState<HostProfile | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void fetch(`/api/host-profile?providerId=${encodeURIComponent(providerId)}`)
      .then(async (response) => {
        const body = (await response.json()) as { data?: HostProfile; error?: string };
        if (!response.ok) throw new Error(body.error || "Unable to load profile");
        if (active) setProfile(body.data ?? null);
      })
      .catch((problem) => {
        if (active) setError(problem instanceof Error ? problem.message : "Unable to load profile");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [providerId]);



  if (loading) {
    return (
      <section className={styles.cardShell}>
        <p className={styles.loadingText}>Loading provider profile…</p>
      </section>
    );
  }

  if (error || !profile) {
    return (
      <section className={styles.cardShell}>
        <p className={styles.errorText}>{error || "Profile unavailable."}</p>
      </section>
    );
  }

  const verifiedBadges: string[] = [];
  if (profile.verified.kyc) verifiedBadges.push("ID Verified");
  if (profile.verified.backgroundCheck) verifiedBadges.push("Background Checked");
  if (profile.verified.homeVerified) verifiedBadges.push("Home Verified");

  return (
    <section className={styles.cardShell}>
      <header className={styles.header}>
        <div
          className={styles.avatar}
          aria-label={`${profile.displayName} photo placeholder`}
        >
          {initials(profile.displayName)}
        </div>
        <div className={styles.identity}>
          <div className={styles.name}>{profile.displayName}</div>
          <div className={styles.meta}>
            {profile.role} · {profile.locationLabel}
          </div>
          <div className={styles.rating}>
            {stars(profile.rating)} <span className={styles.ratingValue}>{profile.rating.toFixed(1)}</span>
            <span className={styles.experience}> · {profile.yearsExperience}y experience</span>
          </div>
        </div>
      </header>

      {verifiedBadges.length > 0 && (
        <div className={styles.badges}>
          {verifiedBadges.map((badge) => (
            <span key={badge} className={styles.badge}>
              ✓ {badge}
            </span>
          ))}
        </div>
      )}

      {profile.about && <p className={styles.about}>{profile.about}</p>}

      {profile.housePhotoRefs.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Home & space</div>
          <div className={styles.photoStrip}>
            {profile.housePhotoRefs.map((ref) => (
              <div
                key={ref}
                className={styles.photoPlaceholder}
                aria-label={`House photo placeholder: ${ref}`}
              >
                🏡
              </div>
            ))}
          </div>
        </div>
      )}

      {profile.specializations.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Specializations</div>
          <div className={styles.chipRow}>
            {profile.specializations.map((item) => (
              <span key={item} className={styles.chip}>
                {item}
              </span>
            ))}
          </div>
        </div>
      )}

      {profile.servicesOffered.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Services offered</div>
          <div className={styles.chipRow}>
            {profile.servicesOffered.map((item) => (
              <span key={item} className={`${styles.chip} ${styles.serviceChip}`}>
                {item}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className={styles.stats}>
        <div className={styles.stat}>
          <div className={styles.statValue}>{profile.stats.happyPets}</div>
          <div className={styles.statLabel}>Happy pets</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statValue}>{profile.stats.onTimePct}%</div>
          <div className={styles.statLabel}>On-time</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statValue}>{profile.stats.happyParents}</div>
          <div className={styles.statLabel}>Happy parents</div>
        </div>
      </div>

      {profile.reviews.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>What pet parents say</div>
          <div className={styles.reviewList}>
            {profile.reviews.map((review, index) => (
              <div
                key={`${review.author}-${index}`}
                className={styles.review}
              >
                <div className={styles.reviewStars}>{stars(review.stars)}</div>
                <p className={styles.reviewText}>{review.text}</p>
                <div className={styles.reviewMeta}>
                  {review.author} · {review.city}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
