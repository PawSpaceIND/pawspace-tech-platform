"use client";

import { useState } from "react";
import styles from "./meet-greet-card.module.css";

type MeetGreetFormat = "phone_call" | "house_visit";

export default function MeetGreetCard(props: {
  customerId?: string;
  hostId?: string;
  intendedStayDays?: number;
  onRequestSuccess?: (requestId: string, format: MeetGreetFormat, price: number) => void;
  onError?: (error: string) => void;
}) {
  const { customerId, hostId, intendedStayDays = 0, onRequestSuccess, onError } = props;

  const [format, setFormat] = useState<MeetGreetFormat>("phone_call");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const getPrice = (): number => {
    if (format === "phone_call") return 0;
    if (format === "house_visit") return intendedStayDays >= 5 ? 0 : 499;
    return 0;
  };

  const price = getPrice();

  const request = async () => {
    if (!date || !time || !customerId || !hostId) {
      setMessage("Please fill in all fields");
      return;
    }

    setLoading(true);
    setMessage("");

    try {
      const dateTime = new Date(`${date}T${time}`);
      const preferredAt = dateTime.getTime();

      if (preferredAt <= Date.now()) {
        setMessage("Preferred time must be in the future");
        setLoading(false);
        return;
      }

      if (format === "house_visit") {
        const hour = dateTime.getUTCHours();
        if (hour < 9 || hour > 18) {
          setMessage("House visits must be between 09:00-19:00 IST");
          setLoading(false);
          return;
        }
      }

      const response = await fetch("/api/meet-and-greet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "create",
          input: {
            customerId,
            hostId,
            format,
            preferredAt,
            intendedStayDays,
          },
        }),
      });

      const result = (await response.json()) as Record<string, unknown>;

      if (!response.ok) {
        setMessage(String(result.error || "Failed to request meet & greet"));
        onError?.(String(result.error || "Request failed"));
        return;
      }

      const data = result.data as { id: string };
      setMessage(`Meet & greet requested · ${format === "phone_call" ? "Free 10-min call" : `₹${price}`}`);
      onRequestSuccess?.(data.id, format, price);
      setDate("");
      setTime("");
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unable to request meet & greet";
      setMessage(msg);
      onError?.(msg);
    } finally {
      setLoading(false);
    }
  };

  const minDate = new Date();
  minDate.setDate(minDate.getDate() + 1);
  const minDateStr = minDate.toISOString().split("T")[0];

  return (
    <section className={styles.card}>
      <header>
        <div>
          <b>Meet & Greet</b>
          <span>Connect with your host before booking</span>
        </div>
      </header>

      <div className={styles.formats}>
        <label className={format === "phone_call" ? styles.selected : ""}>
          <input
            type="radio"
            name="format"
            value="phone_call"
            checked={format === "phone_call"}
            onChange={() => setFormat("phone_call")}
            disabled={!customerId || !hostId || loading}
          />
          <span>Phone Call</span>
          <em>Free 10 min</em>
        </label>
        <label className={format === "house_visit" ? styles.selected : ""}>
          <input
            type="radio"
            name="format"
            value="house_visit"
            checked={format === "house_visit"}
            onChange={() => setFormat("house_visit")}
            disabled={!customerId || !hostId || loading}
          />
          <span>House Visit</span>
          <em>{price === 0 ? "Free" : `₹${price}`}</em>
        </label>
      </div>

      <div className={styles.datetime}>
        <label>
          <span>Preferred Date</span>
          <input
            type="date"
            value={date}
            min={minDateStr}
            disabled={!customerId || !hostId || loading}
            onChange={(e) => setDate(e.target.value)}
            aria-label="Preferred date"
          />
        </label>
        <label>
          <span>Preferred Time</span>
          <input
            type="time"
            value={time}
            disabled={!customerId || !hostId || loading}
            onChange={(e) => setTime(e.target.value)}
            aria-label="Preferred time"
          />
        </label>
      </div>

      <button
        type="button"
        className={styles.request}
        disabled={!customerId || !hostId || !date || !time || loading}
        onClick={request}
      >
        {loading ? "Requesting…" : "Request Meet & Greet"}
      </button>

      {message && <small className={styles.message}>{message}</small>}
    </section>
  );
}
