"use client";
import { useEffect, useState } from "react";
import styles from "./taxi-flow.module.css";
import { loadTaxiRouteClasses, createTaxiQuote, type TaxiRouteClass, type TaxiQuote } from "../../lib/taxi-commercial-client";
import { createCanonicalTaxiBooking, reserveTaxiSchedule, type AssignedDriver, type TaxiBookingResult } from "../../lib/taxi-booking-client";
import PetManager from "./pet-manager";
import { loadCustomerPets, type CustomerPet } from "../../lib/customer-account-client";
import type { LoggedInCustomer } from "./customer-login";
import { resolveServiceCoverage } from "../../lib/service-zone-client";

// Same prop contract as the other embedded flows: the shell passes the logged-in customer; pets
// follow the UAT roster pattern. Pet Taxi carries dogs AND cats — one pet per trip (Gate 1 rule).
const petIcon = (species: string) => (species === "cat" ? "🐈" : species === "dog" ? "🐕" : "🐾");
const petDetail = (pet: CustomerPet) =>
  [pet.profile?.breed || pet.breed, pet.profile?.ageBand, pet.profile?.weightBand].filter(Boolean).join(" · ") ||
  "Profiles, health notes and service history included";

// The scheduler's pet_taxi roster window is 06:00-22:00 IST; the longest UAT route class runs
// 90 minutes, so start chips stop at 20:00 to keep every trip's end inside the roster window.
const PICKUP_HOURS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20] as const;
const IST_OFFSET = 330 * 60_000;

const money = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
const hourLabel = (hour: number) => `${((hour + 11) % 12) + 1}:00 ${hour < 12 ? "AM" : "PM"}`;
function istDate(daysAhead: number, hour: number) { const shifted = new Date(Date.now() + IST_OFFSET); return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + daysAhead, hour, 0) - IST_OFFSET); }
const dayLabel = (value: Date) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" }).format(value);
const slotLabel = (value: Date) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(value);
const timeLabel = (iso: string) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

export default function TaxiFlow({ customer }: { customer: LoggedInCustomer }) {
  const [stage, setStage] = useState(1);
  const [routes, setRoutes] = useState<TaxiRouteClass[]>([]);
  const [routeCode, setRouteCode] = useState("taxi-blr-east-short");
  const [originLabel, setOriginLabel] = useState("");
  const [destinationLabel, setDestinationLabel] = useState("");
  const [dayOffset, setDayOffset] = useState(1);
  const [hour, setHour] = useState(9);
  const [selRaw, setSelectedPet] = useState("");
  // pets is null until the first load resolves — distinguishes "not hydrated" from "hydrated empty"
  // (e.g. the last pet was deleted), so a late initial load can't re-insert a removed pet.
  const [petsState, setPets] = useState<CustomerPet[] | null>(null);
  const pets = petsState ?? [];
  // Selection is always reconciled against the accepted pet list.
  const selectedPet = pets.some((p) => p.id === selRaw) ? selRaw : "";
  const [petsLoading, setPetsLoading] = useState(true);
  const [petsError, setPetsError] = useState("");
  const [showPetManager, setShowPetManager] = useState(false);
  const [quote, setQuote] = useState<TaxiQuote | null>(null);
  const [driver, setDriver] = useState<AssignedDriver | null>(null);
  const [booking, setBooking] = useState<TaxiBookingResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pincode, setPincode] = useState("");

  useEffect(() => {
    let active = true;
    void loadTaxiRouteClasses({ scheduledStart: istDate(1, 9).toISOString() }).then(result => {
      if (!active) return;
      setRoutes(result.routes);
      setRouteCode(current => result.routes.some(item => item.route_code === current) ? current : String(result.routes[0]?.route_code || ""));
    }).catch(problem => { if (active) setError(problem instanceof Error ? problem.message : "Unable to load Pet Taxi routes"); });
    return () => { active = false; };
  }, []);

  const selectedRoute = routes.find(item => item.route_code === routeCode) || null;
  const scheduledStart = istDate(dayOffset, hour).toISOString();
  const pet = pets.find(p => p.id === selectedPet) || pets[0];
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) setPetsLoading(true);
    });
    loadCustomerPets(customer.customerId)
      .then((loaded) => {
        if (!active) return;
        // Do not clobber a pet the user just added/edited/deleted via PetManager if this initial load resolves late.
        setPets((prev) => (prev === null ? loaded : prev));
        setSelectedPet((prev) => (prev ? prev : loaded[0]?.id ?? ""));
        setPetsError("");
      })
      .catch((e) => { if (active) setPetsError(e instanceof Error ? e.message : "Unable to load your pets"); })
      .finally(() => { if (active) setPetsLoading(false); });
    return () => { active = false; };
  }, [customer.customerId]);
  const onPetsChanged = (updated: CustomerPet[]) => {
    setPets(updated);
    setSelectedPet((prev) => (updated.some((p) => p.id === prev) ? prev : updated[0]?.id ?? ""));
  };
  // Mirror of the server rule: pickup and drop-off labels must be real (≥3 chars) and distinct.
  const origin = originLabel.trim(), destination = destinationLabel.trim();
  const locationsValid = origin.length >= 3 && destination.length >= 3 && origin.toLowerCase() !== destination.toLowerCase();

  // Server-quoted price for the review screen — the server also owns the trip end time (route duration).
  useEffect(() => {
    if (stage !== 4 || !selectedRoute || !locationsValid) return;
    let active = true;
    void createTaxiQuote({ routeCode, originLabel: origin, destinationLabel: destination, petCount: 1, scheduledStart })
      .then(value => { if (active) { setQuote(value); setError(""); } })
      .catch(problem => { if (active) { setQuote(null); setError(problem instanceof Error ? problem.message : "Unable to refresh the Pet Taxi quote"); } });
    return () => { active = false; };
  }, [stage, routeCode, origin, destination, scheduledStart, selectedRoute, locationsValid]);

  async function confirm() {
    setBusy(true); setError("");
    try {
      // Fresh server quote at confirmation time (the display quote may have aged past its expiry);
      // the reservation must match the quote's window exactly, so both use the quote's own end time.
      if (!pet) { setError("Add a pet to book a Pet Taxi trip."); setBusy(false); return; }
      const fresh = await createTaxiQuote({ routeCode, originLabel: origin, destinationLabel: destination, petCount: 1, scheduledStart });
      const requestId = `taxi-${customer.customerId}-${fresh.routeCode}-${fresh.scheduledStart}`;
      // Auto-assignment is allowed for taxi (founder rule) — the scheduler picks the driver.
      const coverage = await resolveServiceCoverage(pincode);
      const reservation = await reserveTaxiSchedule({ clientRequestId: requestId, customerId: customer.customerId, petIds: [pet.id], zoneId: coverage.zoneId, scheduledStart: fresh.scheduledStart, scheduledEnd: fresh.scheduledEnd });
      const created = await createCanonicalTaxiBooking({ idempotencyKey: requestId, groupId: reservation.groupId, taxiQuoteId: fresh.quoteId, customer: { id: customer.customerId, name: customer.customerName, primaryPhone: customer.phone }, pets: [{ sourceId: pet.sourceId ?? pet.id, name: pet.name, species: pet.species === "cat" ? "cat" : pet.species === "dog" ? "dog" : "other" }], cityId: coverage.cityId, zoneId: coverage.zoneId, routeCode: fresh.routeCode, originLabel: fresh.originLabel, destinationLabel: fresh.destinationLabel, scheduledStart: fresh.scheduledStart, scheduledEnd: fresh.scheduledEnd, provider: { id: reservation.driver.id, name: reservation.driver.name, model: reservation.driver.model }, totalAmount: fresh.totalAmount, amountDueNow: fresh.amountDueNow, payment: { method: "payment_link", mode: "sandbox_deferred", detail: "Payment remains pending until a verified payment event" } });
      setQuote(fresh); setDriver(reservation.driver); setBooking(created);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Unable to confirm the Pet Taxi booking"); }
    finally { setBusy(false); }
  }

  if (booking && driver) return (
    <div className={styles.wrap}>
      <article className={styles.success}>
        <i>✓</i>
        <small>CANONICAL BOOKING · {booking.bookingId}</small>
        <h3>{pet?.name ?? "Your pet"}&apos;s taxi is booked.</h3>
        <p style={{ margin: "4px 0 0", fontSize: 14 }}>{quote ? `${quote.routeName} · ${money(quote.totalAmount)} · ${money(0)} due today (sandbox deferred)` : "Sandbox deferred billing."}</p>
      </article>
      <span className={styles.label}>Your driver</span>
      <article className={styles.driver}>
        <i>{driver.name.split(" ").map(part => part[0]).join("")}</i>
        <div>
          <b>{driver.name}{driver.rating !== null ? <span className={styles.rating}> · {driver.rating.toFixed(1)} ★</span> : null}</b>
          <small>{driver.rating !== null ? "Rating from the canonical capacity roster" : "Rating pending first reviews"} · {driver.model.replace("_", "-")} driver · auto-assigned with conflict checks</small>
          <small>Vehicle: {booking.trip.id && booking.trip.status === "scheduled" ? "assigned before pickup — details shared in the app" : "assignment pending"}</small>
        </div>
      </article>
      <span className={styles.label}>Trip window</span>
      <div className={styles.trip}>
        <span className={styles.tripLeg}><i>A</i><span><b>{booking.trip.originLabel}</b><small style={{ display: "block" }}>Pickup · {slotLabel(new Date(booking.trip.scheduledStart))}</small></span></span>
        <span className={styles.tripLeg}><i>B</i><span><b>{booking.trip.destinationLabel}</b><small style={{ display: "block" }}>Drop-off by · {timeLabel(booking.trip.scheduledEnd)}</small></span></span>
        <small>{booking.trip.syntheticDistanceKm} km UAT route class · ~{booking.trip.estimatedDurationMinutes} min · status {booking.trip.status}</small>
      </div>
      <p style={{ fontSize: 12, color: "#b8c6c0", marginTop: 12 }}>Sandbox / UAT — no live money, route distances are UAT route classes (not production maps).</p>
    </div>
  );

  return (
    <div className={styles.wrap}>
      <div className={styles.steps}>{[1, 2, 3, 4].map(n => <span key={n} className={stage >= n ? styles.active : ""}>{n}</span>)}</div>

      {stage === 1 && (
        <section>
          <div className={styles.head}><h3>Choose a route class</h3><small>Route · 1 of 4</small></div>
          {!routes.length && !error && <p><small>Loading the canonical Pet Taxi routes…</small></p>}
          {routes.map(item => (
            <button key={item.route_code} className={`${styles.card} ${routeCode === item.route_code ? styles.selected : ""}`} onClick={() => setRouteCode(String(item.route_code))}>
              <span className={styles.cardTop}><b>{item.name}</b><span className={styles.price}>{money(Number(item.amount))}</span></span>
              <span className={styles.meta}>~{Number(item.synthetic_distance_km)} km · ~{Number(item.estimated_duration_minutes)} min · {Number(item.max_pets)} pet per trip · pickup &amp; drop verified in-app</span>
            </button>
          ))}
          {error && <p className={styles.alert} role="alert">{error}</p>}
          <button className={styles.primary} disabled={!selectedRoute} onClick={() => setStage(2)}>Set pickup &amp; drop</button>
        </section>
      )}

      {stage === 2 && (
        <section>
          <div className={styles.head}><h3>Where are we going?</h3><small>Trip · 2 of 4</small></div>
          <span className={styles.label}>Pickup location</span>
          <input className={styles.input} value={originLabel} onChange={event => setOriginLabel(event.target.value)} placeholder="e.g. Indiranagar, 100 Feet Road" maxLength={120} />
          <span className={styles.label}>Drop-off location</span>
          <input className={styles.input} value={destinationLabel} onChange={event => setDestinationLabel(event.target.value)} placeholder="e.g. Whitefield vet clinic" maxLength={120} />
          {!locationsValid && (origin.length > 0 || destination.length > 0) && <p className={styles.note}>Pickup and drop-off need at least 3 characters each and must be different places.</p>}
          <span className={styles.label}>Pickup date</span>
          <div className={styles.chipRow}>
            {[1, 2, 3, 4, 5, 6, 7].map(offset => (
              <button key={offset} className={`${styles.chip} ${dayOffset === offset ? styles.selected : ""}`} onClick={() => setDayOffset(offset)}>{dayLabel(istDate(offset, hour))}</button>
            ))}
          </div>
          <span className={styles.label}>Pickup time</span>
          <div className={styles.chipRow}>
            {PICKUP_HOURS.map(item => (
              <button key={item} className={`${styles.chip} ${hour === item ? styles.selected : ""}`} onClick={() => setHour(item)}>{hourLabel(item)}</button>
            ))}
          </div>
          <p className={styles.note}>Pet Taxi runs between 6:00 AM and 10:00 PM IST — the driver roster hours the scheduler enforces. Drop-off time comes from the route&apos;s canonical duration.</p>
          <button className={styles.primary} disabled={!locationsValid} onClick={() => setStage(3)}>Choose your pet</button>
          <button className={styles.back} onClick={() => setStage(1)}>← Route</button>
        </section>
      )}

      {stage === 3 && (
        <section>
          <div className={styles.head}><h3>Who&apos;s riding?</h3><small>Your pet · 3 of 4</small></div>
          <div className={styles.petGrid}>
            {petsLoading && <p className={styles.note}>Loading your pets…</p>}
            {petsError && <p className={styles.note} role="alert">{petsError}</p>}
            {!petsLoading && !petsError && pets.length === 0 && <p className={styles.note}>No pets on your profile yet — add one below to book.</p>}
            {pets.map(item => (
              <button key={item.id} className={selectedPet === item.id ? styles.selected : ""} onClick={() => setSelectedPet(item.id)}>
                <i>{petIcon(item.species)}</i>
                <span>
                  <b>{item.name}</b>
                  <small>{petDetail(item)}</small>
                </span>
              </button>
            ))}
            <button onClick={() => setShowPetManager(v => !v)}>
              <i>{showPetManager ? "−" : "＋"}</i>
              <span><b>{showPetManager ? "Hide pet details" : "Add or edit pets"}</b></span>
            </button>
          </div>
          {showPetManager && <PetManager customer={customer} onPetsChanged={onPetsChanged} />}
          <p className={styles.note}>Dogs and cats welcome — one pet per trip so the driver&apos;s full attention stays on your companion. 🐾</p>
          <button className={styles.primary} disabled={!pet} onClick={() => { setQuote(null); setStage(4); }}>Review &amp; confirm</button>
          <button className={styles.back} onClick={() => setStage(2)}>← Trip</button>
        </section>
      )}

      {stage === 4 && (
        <section>
          <div className={styles.head}><h3>Review your trip</h3><small>Confirm · 4 of 4</small></div>
          <div className={styles.review}>
            <div><span>Pet</span><b>{pet ? `${pet.name} (${pet.species})` : "—"}</b></div>
            <div><span>Route class</span><b>{quote ? quote.routeName : selectedRoute?.name}</b></div>
            <div><span>Pickup</span><b>{origin}</b></div>
            <div><span>Drop-off</span><b>{destination}</b></div>
            <div><span>Pickup time</span><b>{slotLabel(istDate(dayOffset, hour))}</b></div>
            <div><span>Drop-off by</span><b>{quote ? timeLabel(quote.scheduledEnd) : "Server quote…"}</b></div>
            <div><span>Distance / duration</span><b>{quote ? `~${quote.syntheticDistanceKm} km · ~${quote.estimatedDurationMinutes} min` : "Server quote…"}</b></div>
            <div><span>Fare (sandbox deferred)</span><b>{quote ? money(quote.totalAmount) : "Server quote…"}</b></div>
            <div><span>Due today</span><b>{quote ? money(quote.amountDueNow) : money(0)}</b></div>
          </div>
          <span className={styles.label}>Pickup service PIN code</span>
          <input className={styles.input} value={pincode} inputMode="numeric" maxLength={6} onChange={event => setPincode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="Enter six-digit PIN code" />
          <p className={styles.note}>Coverage is checked from the pickup PIN code. Route distance and time are UAT route classes, not live maps or GPS.</p>
          <p className={styles.note}>Sandbox-deferred billing: nothing is charged now. The fare is the server-quoted route-class price. Your driver is auto-assigned from the canonical roster with full conflict checks; vehicle details are shared before pickup.</p>
          {error && <p className={styles.alert} role="alert">{error}</p>}
          <button className={styles.primary} disabled={busy || !quote || pincode.length !== 6} onClick={() => void confirm()}>
            {busy ? "Reserving your trip…" : !quote ? "Refreshing server quote…" : `Confirm trip · ${money(quote.totalAmount)} sandbox deferred`}
          </button>
          <button className={styles.back} onClick={() => { setQuote(null); setStage(3); }}>← Your pet</button>
        </section>
      )}
    </div>
  );
}
