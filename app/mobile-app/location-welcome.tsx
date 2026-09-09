"use client";

import { useEffect, useRef, useState } from "react";
import { resolveServiceCoverage, type ResolvedServiceCoverage } from "../../lib/service-zone-client";
import styles from "./location-welcome.module.css";
import type { AddressSuggestion, AutocompleteResult, ResolvedAddress } from "../../lib/address-autocomplete";

export const DISCOVERY_PIN_KEY = "pawspace.discovery.pin";
export const WELCOME_SEEN_KEY = "pawspace.welcome.seen.v2";

/** A discovery preference, never a verified doorstep or a booking/price authority. */
export default function LocationWelcome({ onContinue, compact = false }: {
  onContinue: (coverage: ResolvedServiceCoverage | null) => void;
  compact?: boolean;
}) {
  const [pin, setPin] = useState("");
  const [search, setSearch] = useState("");
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [coverage, setCoverage] = useState<ResolvedServiceCoverage | null>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; }, []);

  async function findArea(placeId?: string) {
    const request = ++generation.current;
    setBusy(true); setNote(""); setCoverage(null); setSuggestions([]);
    try {
      const params = placeId ? new URLSearchParams({ mode: "resolve", placeId }) : new URLSearchParams({ mode: "search", query: search.trim() });
      const response = await fetch(`/api/address-autocomplete?${params}`, { cache: "no-store", signal: AbortSignal.timeout(10000) });
      const body = await response.json() as { data?: AutocompleteResult & ResolvedAddress };
      if (request !== generation.current) return;
      if (!response.ok || body.data?.status !== "configured") throw new Error("area_unavailable");
      if (placeId) {
        const foundPin = body.data.address?.match(/\b[1-9]\d{5}\b/)?.[0];
        if (!foundPin) throw new Error("area_unresolved");
        await checkPin(foundPin, request);
      } else {
        setSuggestions(body.data.suggestions ?? []);
        if (!body.data.suggestions?.length) setNote("No matching areas yet. Try a nearby landmark and city.");
      }
    } catch {
      if (request === generation.current) setNote("We couldn’t find that area just now. Try your location, another landmark, or the optional PIN-code fallback.");
    } finally { if (request === generation.current) setBusy(false); }
  }

  async function checkPin(value: string, request: number) {
    try {
      const result = await resolveServiceCoverage(value, AbortSignal.timeout(10000));
      if (request !== generation.current) return;
      setPin(result.pincode);
      setCoverage(result);
      setNote("");
    } catch {
      if (request !== generation.current) return;
      setCoverage(null);
      setNote("We couldn’t confirm care in this area. Check your PIN code or browse without a location.");
    } finally { if (request === generation.current) setBusy(false); }
  }

  async function locate() {
    const request = ++generation.current;
    setCoverage(null);
    setNote("");
    if (!navigator.geolocation) {
      setNote("Location isn’t available in this browser. Search for your neighbourhood instead.");
      return;
    }
    setBusy(true);
    navigator.geolocation.getCurrentPosition(async ({ coords }) => {
      if (request !== generation.current) return;
      try {
        const params = new URLSearchParams({ mode: "reverse", latitude: String(coords.latitude), longitude: String(coords.longitude) });
        const response = await fetch(`/api/address-autocomplete?${params}`, { cache: "no-store", signal: AbortSignal.timeout(10000) });
        const body = await response.json() as { data?: { status?: string; address?: string } };
        const foundPin = body.data?.address?.match(/\b[1-9]\d{5}\b/)?.[0];
        if (!response.ok || body.data?.status !== "configured" || !foundPin) throw new Error("location_unresolved");
        if (request === generation.current) await checkPin(foundPin, request);
      } catch {
        if (request === generation.current) {
          setBusy(false);
          setNote("We couldn’t find your area automatically. Search for your neighbourhood instead.");
        }
      }
    }, (error) => {
      if (request !== generation.current) return;
      setBusy(false);
      setNote(error.code === 1 ? "That’s okay—location access is optional. Search for your neighbourhood instead." : "Location took too long or wasn’t available. Search for your neighbourhood instead.");
    }, { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 });
  }

  function finish(selected: ResolvedServiceCoverage | null) {
    generation.current += 1;
    try {
      sessionStorage.setItem(WELCOME_SEEN_KEY, "1");
      if (selected) sessionStorage.setItem(DISCOVERY_PIN_KEY, selected.pincode);
      else sessionStorage.removeItem(DISCOVERY_PIN_KEY);
    } catch { /* Browsing works without browser storage. */ }
    onContinue(selected);
  }

  return <section className={`${styles.welcome} ${compact ? styles.compact : ""}`} data-location-welcome={compact ? undefined : "true"} aria-labelledby={compact ? "location-edit-title" : "location-welcome-title"}>
    {!compact && <>
      <div className={styles.splash}><span className={styles.locationMark} aria-hidden="true">⌖</span><p>{coverage ? `${coverage.area}, ${coverage.city}` : busy ? "Finding your neighbourhood…" : "Care starts at your doorstep"}</p><img src="/assets/pawspace-official-lockup.png" alt="PawSpace — Your Petter Half" fetchPriority="high" /></div>
    </>}
    <div className={styles.content}>
      <small className={styles.eyebrow}>CARE, CLOSE TO HOME</small>
      <h1 id={compact ? "location-edit-title" : "location-welcome-title"}>{compact ? "Where is home?" : "Where does your pet call home?"}</h1>
      <p>Find your city and service area. Your complete doorstep address and final price are confirmed during booking.</p>
      <button className={styles.primary} onClick={() => void locate()} disabled={busy}>{busy ? "Finding care near you…" : "Use my location"}</button>
      <small className={styles.privacy}>Only when you allow it. Your location is sent to our map service to find your area; we don’t continuously track you.</small>
      <form onSubmit={event => { event.preventDefault(); void findArea(); }}>
        <label htmlFor={compact ? "edit-area-search" : "welcome-area-search"}>Or search your neighbourhood</label>
        <div className={styles.pinRow}><input id={compact ? "edit-area-search" : "welcome-area-search"} value={search} minLength={3} required placeholder="Area, landmark and city" disabled={busy} onChange={event => { setSearch(event.target.value); setCoverage(null); setSuggestions([]); setNote(""); }} /><button disabled={busy || search.trim().length < 3}>Search</button></div>
      </form>
      {suggestions.length > 0 && <ul className={styles.suggestions} aria-label="Matching areas">{suggestions.map(area => <li key={area.placeId}><button disabled={busy} onClick={() => void findArea(area.placeId)}><b>{area.mainText}</b><span>{area.secondaryText}</span></button></li>)}</ul>}
      <details className={styles.fallback}><summary>Can’t find your area? Use a PIN code</summary>
      <form onSubmit={event => { event.preventDefault(); setBusy(true); setCoverage(null); setNote(""); void checkPin(pin, ++generation.current); }}>
        <label htmlFor={compact ? "edit-pin" : "welcome-pin"}>Or enter your area’s PIN code</label>
        <div className={styles.pinRow}><input id={compact ? "edit-pin" : "welcome-pin"} inputMode="numeric" autoComplete="postal-code" value={pin} maxLength={6} pattern="[1-9][0-9]{5}" required placeholder="6-digit PIN code" disabled={busy} onChange={event => { setPin(event.target.value.replace(/\D/g, "").slice(0, 6)); setCoverage(null); setNote(""); }} /><button disabled={busy || !/^[1-9]\d{5}$/.test(pin)}>Check area</button></div>
      </form>
      </details>
      {note && <p className={styles.notice} role="alert">{note}</p>}
      {busy && <span role="status" className={styles.locating}><img src="/assets/pawspace-icon.jpeg" alt="" />Finding care close to your pet…</span>}
      {coverage && <div className={styles.result} role="status"><b>{coverage.city}</b><span>{coverage.area} · {coverage.pincode}</span><button className={styles.primary} onClick={() => finish(coverage)}>Continue in {coverage.city} →</button></div>}
      <button className={styles.skip} onClick={() => finish(null)}>Browse without location</button>
    </div>
  </section>;
}
