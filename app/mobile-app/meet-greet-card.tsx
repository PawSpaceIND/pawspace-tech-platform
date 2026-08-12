"use client";

import { useState } from "react";
import styles from "./meet-greet-card.module.css";

type MeetGreetFormat = "phone" | "house_visit";

type RequestedMeetGreet = {
  id: string;
  format: MeetGreetFormat;
  preferredAt: number;
  priceCharged: number;
  priceWaivedReason: string | null;
  status: string;
};

/** Client-side mirror of the server rule for live display only — the server re-prices every request. */
function previewPrice(format: MeetGreetFormat, intendedStayDays: number): { amount: number; waived: boolean } {
  if (format === "phone") return { amount: 0, waived: false };
  if (intendedStayDays >= 5) return { amount: 0, waived: true };
  return { amount: 499, waived: false };
}

export default function MeetGreetCard(props: {
  hostProviderId: string;
  hostName: string;
  intendedStayDays: number;
  onRequested?: (request: RequestedMeetGreet) => void;
  customerId?: string;
}) {
  const { hostProviderId, hostName, intendedStayDays, onRequested, customerId } = props;

  const [format, setFormat] = useState<MeetGreetFormat>("phone");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [guestName, setGuestName] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [confirmed, setConfirmed] = useState<RequestedMeetGreet | null>(null);

  const phonePrice = previewPrice("phone", intendedStayDays);
  const visitPrice = previewPrice("house_visit", intendedStayDays);
  const selectedPrice = format === "phone" ? phonePrice : visitPrice;

  const guestDigits = guestPhone.replace(/\D/g, "");
  const resolvedCustomerId = customerId || (guestDigits.length >= 10 ? `guest:${guestDigits}` : "");
  const ready = Boolean(hostProviderId && resolvedCustomerId && date && time && !loading);

  const submit = async () => {
    if (!ready) return;
    setLoading(true);
    setError("");
    try {
      const preferredAt = new Date(`${date}T${time}`).getTime();
      if (!Number.isFinite(preferredAt) || preferredAt <= Date.now()) {
        setError("Pick a future date and time");
        return;
      }
      const response = await fetch("/api/meet-and-greet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customerId: resolvedCustomerId,
          hostProviderId,
          format,
          preferredAt,
          intendedStayDays,
          notes: customerId ? undefined : `Guest contact: ${guestName.trim()} · ${guestPhone.trim()}`,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        setError(String(payload.error || "Unable to request the meet & greet"));
        return;
      }
      const data = payload.data as RequestedMeetGreet;
      setConfirmed(data);
      onRequested?.(data);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Unable to request the meet & greet");
    } finally {
      setLoading(false);
    }
  };

  if (confirmed) {
    return (
      <section className={styles.card} aria-live="polite">
        <div className={styles.confirmed}>
          <b>Meet &amp; Greet requested ✓</b>
          <p>
            {confirmed.format === "phone" ? "10-minute phone call" : "4-hour house visit"} with {hostName} ·{" "}
            {confirmed.priceCharged === 0 ? "FREE" : `₹${confirmed.priceCharged}`}
            {confirmed.priceWaivedReason === "stay_5_days_or_more" ? " (waived — stay of 5+ days)" : ""}
          </p>
          <p>
            Preferred: {new Date(confirmed.preferredAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST
          </p>
          <small>
            Request {confirmed.id} · {hostName} will confirm shortly. Cancel any time — 100% refund, zero cancellation fee.
          </small>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.card}>
      <header className={styles.header}>
        <b>Meet &amp; Greet with {hostName}</b>
        <span>Build confidence before you book the stay</span>
      </header>

      <div className={styles.formats} role="radiogroup" aria-label="Meet and greet format">
        <label className={format === "phone" ? styles.selected : ""}>
          <input type="radio" name="mg-format" value="phone" checked={format === "phone"} onChange={() => setFormat("phone")} disabled={loading} />
          <span>Phone call</span>
          <small>10 minutes</small>
          <em>FREE</em>
        </label>
        <label className={format === "house_visit" ? styles.selected : ""}>
          <input type="radio" name="mg-format" value="house_visit" checked={format === "house_visit"} onChange={() => setFormat("house_visit")} disabled={loading} />
          <span>House visit</span>
          <small>4 hours at the host&apos;s home</small>
          <em>{visitPrice.amount === 0 ? "FREE" : `₹${visitPrice.amount}`}</em>
        </label>
      </div>

      <p className={styles.waiver}>
        {format === "house_visit"
          ? visitPrice.waived
            ? `Free with stays of 5+ days — your ${intendedStayDays}-day stay qualifies.`
            : `Free with stays of 5+ days. Your ${intendedStayDays}-day stay is under 5 days, so the visit is ₹499.`
          : "Phone calls are always free."}
      </p>

      {!customerId && (
        <div className={styles.guest}>
          <label>
            <span>Your name</span>
            <input value={guestName} onChange={(event) => setGuestName(event.target.value)} placeholder="Full name" disabled={loading} />
          </label>
          <label>
            <span>Phone number</span>
            <input value={guestPhone} inputMode="tel" onChange={(event) => setGuestPhone(event.target.value)} placeholder="10-digit mobile" disabled={loading} />
          </label>
        </div>
      )}

      <div className={styles.datetime}>
        <label>
          <span>Preferred date</span>
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} disabled={loading} />
        </label>
        <label>
          <span>Preferred time{format === "house_visit" ? " (09:00–15:00 IST start)" : ""}</span>
          <input type="time" value={time} onChange={(event) => setTime(event.target.value)} disabled={loading} />
        </label>
      </div>

      <button type="button" className={styles.submit} disabled={!ready} onClick={() => void submit()}>
        {loading ? "Requesting…" : `Request ${format === "phone" ? "free call" : "house visit"}${selectedPrice.amount ? ` · ₹${selectedPrice.amount}` : ""}`}
      </button>

      {error && (
        <small role="alert" className={styles.error}>
          {error}
        </small>
      )}
    </section>
  );
}
