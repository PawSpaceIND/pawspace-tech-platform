"use client";
/* eslint-disable @next/next/no-img-element */
// PawSpace launch splash — brand mark, premium pet photography and a real location capture, then it
// hands over to the home screen (the Swiggy pattern: locate first, browse second).
//
// Honesty rules this screen follows:
//  - The location shown is whatever the device and the configured geocoder actually returned. When
//    reverse geocoding is not connected, it says "Location captured" with the real coordinates and
//    the serviceable city rather than inventing a street address.
//  - Permission denied is a normal outcome, not an error state: the customer continues and picks an
//    address later in the booking flow, exactly as before.
//  - It never blocks entry. A slow or silent geolocation call times out and moves on.
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./splash.module.css";
import { reverseGeocodeCoordinates } from "../../lib/address-autocomplete-client";

export const SPLASH_LOCATION_KEY = "pawspace.customer.location";

export type CapturedLocation = {
  label: string;
  detail: string;
  latitude: number | null;
  longitude: number | null;
  source: "geocoded" | "coordinates_only" | "declined" | "unsupported";
};

const HOLD_MS = 900;          // brand moment before the locate step is offered
const GEO_TIMEOUT_MS = 12_000;

export default function Splash({ onDone }: { onDone: (location: CapturedLocation | null) => void }) {
  const [phase, setPhase] = useState<"brand" | "locating" | "found">("brand");
  const [status, setStatus] = useState("Getting things ready…");
  const [captured, setCaptured] = useState<CapturedLocation | null>(null);
  const finished = useRef(false);

  const finish = useCallback((location: CapturedLocation | null) => {
    if (finished.current) return;
    finished.current = true;
    if (location) { try { window.localStorage.setItem(SPLASH_LOCATION_KEY, JSON.stringify(location)); } catch { /* private mode */ } }
    onDone(location);
  }, [onDone]);

  const locate = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setStatus("This device can't share a location — you can pick your address while booking.");
      setCaptured({ label: "Bengaluru", detail: "Choose your exact address at booking", latitude: null, longitude: null, source: "unsupported" });
      setPhase("found");
      return;
    }
    setPhase("locating");
    setStatus("Finding your location…");
    navigator.geolocation.getCurrentPosition(
      async position => {
        const { latitude, longitude } = position.coords;
        let location: CapturedLocation = {
          label: "Location captured",
          detail: `${latitude.toFixed(4)}, ${longitude.toFixed(4)} · confirm your address at booking`,
          latitude, longitude, source: "coordinates_only",
        };
        try {
          const resolved = await reverseGeocodeCoordinates(latitude, longitude);
          if (resolved.status === "configured" && resolved.address) {
            const parts = resolved.address.split(",").map(part => part.trim()).filter(Boolean);
            location = { label: parts[0] || "Your location", detail: parts.slice(1).join(", ") || resolved.address, latitude, longitude, source: "geocoded" };
          }
        } catch { /* keep the honest coordinates-only reading */ }
        setCaptured(location);
        setStatus(location.source === "geocoded" ? "Delivering care to" : "Location captured");
        setPhase("found");
      },
      error => {
        setCaptured({ label: "Bengaluru", detail: "Location off — pick your address while booking", latitude: null, longitude: null, source: "declined" });
        setStatus(error.code === error.PERMISSION_DENIED ? "No problem — you can pick your address while booking." : "Couldn't get a location just now.");
        setPhase("found");
      },
      { enableHighAccuracy: true, timeout: GEO_TIMEOUT_MS, maximumAge: 60_000 },
    );
  }, []);

  useEffect(() => {
    const hold = window.setTimeout(() => locate(), HOLD_MS);
    return () => window.clearTimeout(hold);
  }, [locate]);

  // Once we have an answer, pause just long enough for the customer to read it, then enter the app.
  useEffect(() => {
    if (phase !== "found") return;
    const move = window.setTimeout(() => finish(captured), 1100);
    return () => window.clearTimeout(move);
  }, [phase, captured, finish]);

  return (
    <div className={styles.splash} role="status" aria-live="polite">
      <div className={styles.glow} aria-hidden="true" />

      <div className={styles.brand}>
        <span className={styles.tile}>
          <img src="/assets/pawspace-logo.jpeg" alt="PawSpace" />
        </span>
        <p className={styles.tagline}>Care that comes home to them.</p>
      </div>

      {/* Dog and cat, both first-class citizens of the brand. Two real photographs in matching
          arches rather than one composite that would pretend a single shot exists. */}
      <div className={styles.pets} aria-hidden="true">
        <figure className={styles.petDog}><img src="/assets/banners/sitter-hug-golden.jpg" alt="" /></figure>
        <figure className={styles.petCat}><img src="/assets/banners/sitting-woman-cat.jpg" alt="" /></figure>
      </div>

      <div className={styles.locate}>
        {phase === "found" && captured ? (
          <div className={styles.found}>
            <i className={styles.pin} aria-hidden="true">◉</i>
            <div>
              <small>{status}</small>
              <b>{captured.label}</b>
              <span>{captured.detail}</span>
            </div>
          </div>
        ) : (
          <div className={styles.working}>
            <i className={styles.spinner} aria-hidden="true" />
            <span>{status}</span>
          </div>
        )}
        <button type="button" className={styles.skip} onClick={() => finish(captured)}>
          {phase === "found" ? "Continue →" : "Skip"}
        </button>
      </div>

      <ul className={styles.trust}>
        <li>Verified professionals</li>
        <li>Live updates</li>
        <li>100% refund policy</li>
      </ul>
    </div>
  );
}
