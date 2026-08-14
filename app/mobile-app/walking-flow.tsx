"use client";
import { useEffect, useState } from "react";
import styles from "./walking-flow.module.css";
import { loadWalkingCatalogue, createWalkingQuote, type WalkingPackage, type WalkingQuote } from "../../lib/walking-commercial-client";
import { createCanonicalWalkingBooking, reserveWalkingSchedule, type AssignedWalker, type WalkingBookingResult } from "../../lib/walking-booking-client";
import type { LoggedInCustomer } from "./customer-login";
import type { ResolvedLocation } from "./resolved-location";

// Same prop contract as training-flow.tsx: the shell passes the logged-in customer; pets follow the
// UAT roster pattern the other flows use. Walking is a dogs-only service, so the roster keeps the
// household cat visible but never bookable.
const walkingPets = [
  { name: "Bruno", detail: "Golden Retriever · 4 years", icon: "🐕", species: "dog" },
  { name: "Milo", detail: "Beagle · 2 years", icon: "🐶", species: "dog" },
  { name: "Luna", detail: "Indie · 3 years", icon: "🐕", species: "dog" },
  { name: "Coco", detail: "Persian cat · 3 years", icon: "🐈", species: "cat" },
] as const;

// Walker roster hours enforced by the scheduling API for dog_walking are 06:00-21:00 IST; every
// offered slot keeps start ≥ 06:00 and end ≤ 21:00 for both the 30- and 60-minute packages.
const WALK_START_HOURS = [6, 7, 8, 9, 10, 16, 17, 18, 19, 20] as const;
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const IST_OFFSET = 330 * 60_000;

const money = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
const hourLabel = (hour: number) => `${((hour + 11) % 12) + 1}:00 ${hour < 12 ? "AM" : "PM"}`;
function istDate(daysAhead: number, hour: number) { const shifted = new Date(Date.now() + IST_OFFSET); return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + daysAhead, hour, 0) - IST_OFFSET); }
const istWeekday = (value: Date) => new Date(value.getTime() + IST_OFFSET).getUTCDay();
const dayLabel = (value: Date) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" }).format(value);
const slotLabel = (value: Date) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(value);
const windowLabel = (start: string, end: string) => `${slotLabel(new Date(start))} – ${new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" }).format(new Date(end))}`;
// First walk lands on a chosen weekday so the scheduler's occurrence 1 matches the quoted window exactly.
function firstRecurringDay(weekdays: number[], hour: number) { for (let offset = 1; offset <= 28; offset++) { const candidate = istDate(offset, hour); if (weekdays.includes(istWeekday(candidate))) return candidate; } return istDate(1, hour); }

export default function WalkingFlow({ customer, location }: { customer: LoggedInCustomer; location: ResolvedLocation }) {
  const [stage, setStage] = useState(1);
  const [packages, setPackages] = useState<WalkingPackage[]>([]);
  const [packageCode, setPackageCode] = useState("walking-30");
  const [mode, setMode] = useState<"once" | "recurring">("recurring");
  const [weekdays, setWeekdays] = useState<number[]>([1, 3, 5]);
  const [walkCount, setWalkCount] = useState(6);
  const [onceOffset, setOnceOffset] = useState(1);
  const [hour, setHour] = useState(7);
  const [selectedPet, setSelectedPet] = useState("Bruno");
  const [quote, setQuote] = useState<WalkingQuote | null>(null);
  const [walker, setWalker] = useState<AssignedWalker | null>(null);
  const [booking, setBooking] = useState<WalkingBookingResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const flash = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 2800); };

  useEffect(() => {
    let active = true;
    void loadWalkingCatalogue({ scheduledStart: istDate(1, 7).toISOString() }).then(result => {
      if (!active) return;
      setPackages(result.packages);
      setPackageCode(current => result.packages.some(item => item.package_code === current) ? current : String(result.packages[0]?.package_code || ""));
    }).catch(problem => { if (active) setError(problem instanceof Error ? problem.message : "Unable to load the Dog Walking catalogue"); });
    return () => { active = false; };
  }, []);

  const selectedPackage = packages.find(item => item.package_code === packageCode) || null;
  const durationMinutes = Number(selectedPackage?.duration_minutes || 30);
  const effectiveWalks = mode === "once" ? 1 : walkCount;
  const firstWalk = mode === "once" ? istDate(onceOffset, hour) : firstRecurringDay(weekdays, hour);
  const scheduledStart = firstWalk.toISOString();
  const scheduledEnd = new Date(firstWalk.getTime() + durationMinutes * 60_000).toISOString();

  const toggleWeekday = (day: number) => setWeekdays(current => current.includes(day) ? (current.length === 1 ? current : current.filter(item => item !== day)) : [...current, day].sort((a, b) => a - b));
  const pickPet = (pet: typeof walkingPets[number]) => {
    if (pet.species !== "dog") { flash(`${pet.name} will sit this one out — dog walking is a dogs-only service. Pick one of your dogs and off you go! 🐾`); return; }
    setSelectedPet(pet.name);
  };

  // Server-quoted price for the review screen — prices always come from /api/walking-commercial.
  useEffect(() => {
    if (stage !== 4 || !selectedPackage) return;
    let active = true;
    void createWalkingQuote({ packageCode, mode, petCount: 1, walkCount: effectiveWalks, weekdays: mode === "recurring" ? weekdays : undefined, scheduledStart, scheduledEnd })
      .then(value => { if (active) { setQuote(value); setError(""); } })
      .catch(problem => { if (active) { setQuote(null); setError(problem instanceof Error ? problem.message : "Unable to refresh the Dog Walking quote"); } });
    return () => { active = false; };
  }, [stage, packageCode, mode, effectiveWalks, weekdays, scheduledStart, scheduledEnd, selectedPackage]);

  async function confirm() {
    setBusy(true); setError("");
    try {
      // Fresh server quote at confirmation time (display quote may have aged past its expiry).
      const fresh = await createWalkingQuote({ packageCode, mode, petCount: 1, walkCount: effectiveWalks, weekdays: mode === "recurring" ? weekdays : undefined, scheduledStart, scheduledEnd });
      const requestId = `walking-${customer.customerId}-${fresh.packageCode}-${scheduledStart}-${mode === "recurring" ? weekdays.join("") : "once"}x${fresh.walkCount}`;
      // Auto-assignment is allowed for walking (founder rule) — the scheduler picks the walker.
      const reservation = await reserveWalkingSchedule({ clientRequestId: requestId, customerId: customer.customerId, petIds: [selectedPet], cityId: location.cityId, zoneId: location.zoneId, scheduledStart, scheduledEnd, walkCount: fresh.walkCount, weekdays: mode === "recurring" ? weekdays : undefined });
      const created = await createCanonicalWalkingBooking({ idempotencyKey: requestId, groupId: reservation.groupId, walkingQuoteId: fresh.quoteId, customer: { id: customer.customerId, name: customer.customerName, primaryPhone: customer.phone }, pets: [{ sourceId: selectedPet, name: selectedPet, species: "dog" }], cityId: location.cityId, zoneId: location.zoneId, packageCode: fresh.packageCode, packageName: fresh.packageName, walkCount: fresh.walkCount, weekdays: fresh.weekdays, scheduledStart, scheduledEnd, provider: { id: reservation.walker.id, name: reservation.walker.name, model: reservation.walker.model }, totalAmount: fresh.totalAmount, amountDueNow: fresh.amountDueNow, payment: { method: "upi", mode: "pay_after_service", detail: "UAT pay-after-service Dog Walking sandbox billing" } });
      setQuote(fresh); setWalker(reservation.walker); setBooking(created);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Unable to confirm the Dog Walking booking"); }
    finally { setBusy(false); }
  }

  if (booking && walker) return (
    <div className={styles.wrap}>
      <article className={styles.success}>
        <i>✓</i>
        <small>CANONICAL BOOKING · {booking.bookingId}</small>
        <h3>{selectedPet}&apos;s walks are booked.</h3>
        <p style={{ margin: "4px 0 0", fontSize: 14 }}>{quote ? `${quote.packageName} · ${quote.walkCount} walk${quote.walkCount === 1 ? "" : "s"} · ${money(quote.perWalkAmount)} after each completed walk · ${money(0)} due today` : "Pay after each completed walk."}</p>
      </article>
      <span className={styles.label}>Your walker</span>
      <article className={styles.walker}>
        <i>{walker.name.split(" ").map(part => part[0]).join("")}</i>
        <div>
          <b>{walker.name}{walker.rating !== null ? <span className={styles.rating}> · {walker.rating.toFixed(1)} ★</span> : null}</b>
          <small>{walker.rating !== null ? "Rating from the canonical capacity roster" : "Rating pending first reviews"} · {walker.model.replace("_", "-")} walker · auto-assigned with conflict checks</small>
        </div>
      </article>
      <span className={styles.label}>Walk calendar</span>
      <div className={styles.sessions}>
        {booking.sessions.map(session => (
          <span key={session.id}><i>{session.occurrenceNumber}</i>{windowLabel(session.scheduledStart, session.scheduledEnd)}<em>{session.status}</em></span>
        ))}
      </div>
      <p style={{ fontSize: 12, color: "#b8c6c0", marginTop: 12 }}>Sandbox / UAT — no live money. Each walk is billed only after it is completed and verified.</p>
    </div>
  );

  return (
    <div className={styles.wrap}>
      {toast && <div className={styles.toast}>{toast}</div>}
      <div className={styles.steps}>{[1, 2, 3, 4].map(n => <span key={n} className={stage >= n ? styles.active : ""}>{n}</span>)}</div>

      {stage === 1 && (
        <section>
          <div className={styles.head}><h3>Choose a walk package</h3><small>Package · 1 of 4</small></div>
          <div className={styles.modeRow}>
            <button className={`${styles.chip} ${mode === "recurring" ? styles.selected : ""}`} onClick={() => setMode("recurring")}>Recurring weekly walks</button>
            <button className={`${styles.chip} ${mode === "once" ? styles.selected : ""}`} onClick={() => setMode("once")}>Just once</button>
          </div>
          {!packages.length && !error && <p><small>Loading the canonical Dog Walking catalogue…</small></p>}
          {packages.map(item => (
            <button key={item.package_code} className={`${styles.card} ${packageCode === item.package_code ? styles.selected : ""}`} onClick={() => setPackageCode(String(item.package_code))}>
              <span className={styles.cardTop}><b>{item.name}</b><span className={styles.price}>{money(Number(item.amount_per_walk))} / walk</span></span>
              <span className={styles.meta}>{Number(item.duration_minutes)} minutes · solo walk for {Number(item.max_pets)} dog · GPS-tracked · pay only after each completed walk</span>
            </button>
          ))}
          {error && <p className={styles.alert} role="alert">{error}</p>}
          <button className={styles.primary} disabled={!selectedPackage} onClick={() => setStage(2)}>Plan the schedule</button>
        </section>
      )}

      {stage === 2 && (
        <section>
          <div className={styles.head}><h3>When should we walk?</h3><small>Schedule · 2 of 4</small></div>
          {mode === "recurring" ? (
            <>
              <span className={styles.label}>Days of the week</span>
              <div className={styles.chipRow}>
                {WEEKDAY_LABELS.map((label, day) => (
                  <button key={label} className={`${styles.chip} ${weekdays.includes(day) ? styles.selected : ""}`} onClick={() => toggleWeekday(day)}>{label}</button>
                ))}
              </div>
              <span className={styles.label}>Walks in this booking</span>
              <div className={styles.stepper}>
                <button disabled={walkCount <= 2} onClick={() => setWalkCount(count => Math.max(2, count - 1))}>−</button>
                <b>{walkCount} walks</b>
                <button disabled={walkCount >= 12} onClick={() => setWalkCount(count => Math.min(12, count + 1))}>＋</button>
              </div>
              <p className={styles.note}>Recurring bookings reserve 2–12 walks with one dedicated walker. First walk: <b>{dayLabel(firstWalk)}</b>.</p>
            </>
          ) : (
            <>
              <span className={styles.label}>Walk date</span>
              <div className={styles.chipRow}>
                {[1, 2, 3, 4, 5, 6, 7].map(offset => (
                  <button key={offset} className={`${styles.chip} ${onceOffset === offset ? styles.selected : ""}`} onClick={() => setOnceOffset(offset)}>{dayLabel(istDate(offset, hour))}</button>
                ))}
              </div>
            </>
          )}
          <span className={styles.label}>Start time</span>
          <div className={styles.chipRow}>
            {WALK_START_HOURS.map(item => (
              <button key={item} className={`${styles.chip} ${hour === item ? styles.selected : ""}`} onClick={() => setHour(item)}>{hourLabel(item)}</button>
            ))}
          </div>
          <p className={styles.note}>Walks run between 6:00 AM and 9:00 PM IST — the walker roster hours the scheduler enforces. Your {durationMinutes}-minute walk window ends by 9:00 PM.</p>
          <button className={styles.primary} onClick={() => setStage(3)}>Choose your dog</button>
          <button className={styles.back} onClick={() => setStage(1)}>← Package</button>
        </section>
      )}

      {stage === 3 && (
        <section>
          <div className={styles.head}><h3>Who&apos;s walking?</h3><small>Your dog · 3 of 4</small></div>
          <div className={styles.petGrid}>
            {walkingPets.map(pet => (
              <button key={pet.name} className={pet.species === "dog" && selectedPet === pet.name ? styles.selected : ""} onClick={() => pickPet(pet)} aria-disabled={pet.species !== "dog"}>
                <i>{pet.icon}</i>
                <span>
                  <b>{pet.name}</b>
                  <small>{pet.detail}</small>
                  {pet.species !== "dog" && <span className={styles.dogsOnly}>DOGS ONLY</span>}
                </span>
              </button>
            ))}
          </div>
          <p className={styles.note}>Dog walking is a solo, dogs-only service — one dog per booking so every walk gets the walker&apos;s full attention. Cats in the family stay comfortably home. 🐈</p>
          <button className={styles.primary} onClick={() => { setQuote(null); setStage(4); }}>Review &amp; confirm</button>
          <button className={styles.back} onClick={() => setStage(2)}>← Schedule</button>
        </section>
      )}

      {stage === 4 && (
        <section>
          <div className={styles.head}><h3>Review your walks</h3><small>Confirm · 4 of 4</small></div>
          <div className={styles.review}>
            <div><span>Dog</span><b>{selectedPet}</b></div>
            <div><span>Package</span><b>{quote ? quote.packageName : selectedPackage?.name} · {durationMinutes} min</b></div>
            <div><span>Schedule</span><b>{mode === "recurring" ? `${weekdays.map(day => WEEKDAY_LABELS[day]).join(", ")} · ${hourLabel(hour)}` : slotLabel(firstWalk)}</b></div>
            <div><span>First walk</span><b>{slotLabel(firstWalk)}</b></div>
            <div><span>Walks reserved</span><b>{quote ? quote.walkCount : effectiveWalks}</b></div>
            <div><span>Per walk</span><b>{quote ? money(quote.perWalkAmount) : "Server quote…"}</b></div>
            <div><span>Total (pay after service)</span><b>{quote ? money(quote.totalAmount) : "Server quote…"}</b></div>
            <div><span>Due today</span><b>{quote ? money(quote.amountDueNow) : money(0)}</b></div>
          </div>
          <p className={styles.note}>Pay-after-service: nothing is charged now. Each walk is billed at the server-quoted per-walk price only after it is completed. Your walker is auto-assigned from the canonical roster with full-calendar conflict checks.</p>
          {error && <p className={styles.alert} role="alert">{error}</p>}
          <button className={styles.primary} disabled={busy || !quote} onClick={() => void confirm()}>
            {busy ? "Reserving your walk calendar…" : !quote ? "Refreshing server quote…" : `Confirm ${quote.walkCount} walk${quote.walkCount === 1 ? "" : "s"} · ${money(quote.totalAmount)} after service`}
          </button>
          <button className={styles.back} onClick={() => { setQuote(null); setStage(3); }}>← Your dog</button>
        </section>
      )}
    </div>
  );
}
