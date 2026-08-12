"use client";
// Standalone, self-contained host/sitter profile card - deliberately does not import anything from
// any other in-flight booking-flow stream's files. Renders /api/host-profile data (demo/UAT
// profiles, see lib/host-profiles.ts). No real media assets: photoRef/housePhotoRefs are
// media-by-reference placeholder strings, rendered here as initials/emoji tiles, never an image tag.
import { useEffect, useState } from "react";

const EMERALD = "#01261F";
const GOLD = "#E6B34E";
const IVORY = "#F6F2E9";

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

const badgeStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  fontSize: 12,
  fontWeight: 600,
  padding: "4px 10px",
  borderRadius: 999,
  background: "rgba(230,179,78,0.16)",
  color: GOLD,
  border: `1px solid ${GOLD}`,
};

const chipStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  padding: "6px 12px",
  borderRadius: 999,
  background: "rgba(255,255,255,0.08)",
  color: IVORY,
  border: "1px solid rgba(255,255,255,0.16)",
};

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

  const cardShell: React.CSSProperties = {
    background: EMERALD,
    color: IVORY,
    borderRadius: 20,
    padding: 20,
    fontFamily: "system-ui, -apple-system, sans-serif",
    maxWidth: 420,
    boxShadow: "0 12px 28px rgba(1,38,31,0.35)",
  };

  if (loading) {
    return (
      <section style={cardShell}>
        <p style={{ margin: 0, opacity: 0.8 }}>Loading provider profile…</p>
      </section>
    );
  }

  if (error || !profile) {
    return (
      <section style={cardShell}>
        <p style={{ margin: 0, opacity: 0.85 }}>{error || "Profile unavailable."}</p>
      </section>
    );
  }

  const verifiedBadges: string[] = [];
  if (profile.verified.kyc) verifiedBadges.push("ID Verified");
  if (profile.verified.backgroundCheck) verifiedBadges.push("Background Checked");
  if (profile.verified.homeVerified) verifiedBadges.push("Home Verified");

  return (
    <section style={cardShell}>
      <header style={{ display: "flex", gap: 14, alignItems: "center" }}>
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: "50%",
            background: GOLD,
            color: EMERALD,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 22,
            fontWeight: 700,
            flexShrink: 0,
          }}
          aria-label={`${profile.displayName} photo placeholder`}
        >
          {initials(profile.displayName)}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{profile.displayName}</div>
          <div style={{ fontSize: 13, opacity: 0.8 }}>
            {profile.role} · {profile.locationLabel}
          </div>
          <div style={{ fontSize: 13, color: GOLD, marginTop: 2 }}>
            {stars(profile.rating)} <span style={{ color: IVORY, opacity: 0.85 }}>{profile.rating.toFixed(1)}</span>
            <span style={{ opacity: 0.7 }}> · {profile.yearsExperience}y experience</span>
          </div>
        </div>
      </header>

      {verifiedBadges.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 14 }}>
          {verifiedBadges.map((badge) => (
            <span key={badge} style={badgeStyle}>
              ✓ {badge}
            </span>
          ))}
        </div>
      )}

      {profile.about && <p style={{ fontSize: 14, lineHeight: 1.5, opacity: 0.9, marginTop: 14 }}>{profile.about}</p>}

      {profile.housePhotoRefs.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, opacity: 0.7, letterSpacing: 0.4, textTransform: "uppercase" }}>Home & space</div>
          <div style={{ display: "flex", gap: 8, marginTop: 8, overflowX: "auto" }}>
            {profile.housePhotoRefs.map((ref) => (
              <div
                key={ref}
                style={{
                  width: 72,
                  height: 56,
                  borderRadius: 10,
                  background: "rgba(255,255,255,0.08)",
                  border: "1px solid rgba(255,255,255,0.16)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 20,
                  flexShrink: 0,
                }}
                aria-label={`House photo placeholder: ${ref}`}
              >
                🏡
              </div>
            ))}
          </div>
        </div>
      )}

      {profile.specializations.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, opacity: 0.7, letterSpacing: 0.4, textTransform: "uppercase" }}>Specializations</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            {profile.specializations.map((item) => (
              <span key={item} style={chipStyle}>
                {item}
              </span>
            ))}
          </div>
        </div>
      )}

      {profile.servicesOffered.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, opacity: 0.7, letterSpacing: 0.4, textTransform: "uppercase" }}>Services offered</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            {profile.servicesOffered.map((item) => (
              <span key={item} style={{ ...chipStyle, background: "rgba(230,179,78,0.16)", color: GOLD, border: `1px solid ${GOLD}` }}>
                {item}
              </span>
            ))}
          </div>
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 8,
          marginTop: 16,
          padding: "12px 0",
          borderTop: "1px solid rgba(255,255,255,0.16)",
          borderBottom: "1px solid rgba(255,255,255,0.16)",
        }}
      >
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: GOLD }}>{profile.stats.happyPets}</div>
          <div style={{ fontSize: 11, opacity: 0.7 }}>Happy pets</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: GOLD }}>{profile.stats.onTimePct}%</div>
          <div style={{ fontSize: 11, opacity: 0.7 }}>On-time</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: GOLD }}>{profile.stats.happyParents}</div>
          <div style={{ fontSize: 11, opacity: 0.7 }}>Happy parents</div>
        </div>
      </div>

      {profile.reviews.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, opacity: 0.7, letterSpacing: 0.4, textTransform: "uppercase" }}>What pet parents say</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
            {profile.reviews.map((review, index) => (
              <div
                key={`${review.author}-${index}`}
                style={{ background: "rgba(255,255,255,0.06)", borderRadius: 12, padding: 12 }}
              >
                <div style={{ fontSize: 12, color: GOLD }}>{stars(review.stars)}</div>
                <p style={{ fontSize: 13, lineHeight: 1.45, margin: "6px 0 0", opacity: 0.92 }}>{review.text}</p>
                <div style={{ fontSize: 12, opacity: 0.65, marginTop: 6 }}>
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
