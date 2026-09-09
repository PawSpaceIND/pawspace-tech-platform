"use client";
// Embedded Pet Relocation enquiry — the founder's field contract (name, primary + optional
// secondary phone, email, pet type dog/cat, pickup date + approx time, pickup and drop locations,
// expected travel date) plus DOMESTIC / INTERNATIONAL capture. Posts to the existing public
// /api/relocation-enquiry route; the server re-validates every field. No booking or money here —
// relocation is quoted by the ops team after triage (staff list at /team/relocation-enquiries).
import { useState } from "react";
import styles from "./relocation-flow.module.css";
import type { LoggedInCustomer } from "./customer-login";

type Submitted = { id: string; relocationKind: string };

const todayPlus = (days: number) => {
  const at = new Date(Date.now() + days * 86_400_000 + 330 * 60_000);
  return at.toISOString().slice(0, 10);
};

export default function RelocationFlow({ customer }: { customer: LoggedInCustomer }) {
  const [kind, setKind] = useState<"domestic" | "international">("domestic");
  const [petType, setPetType] = useState<"dog" | "cat">("dog");
  const [name, setName] = useState(customer.customerName);
  const [phone, setPhone] = useState(customer.phone.replace(/\D/g, "").slice(-10));
  const [phoneSecondary, setPhoneSecondary] = useState("");
  const [email, setEmail] = useState("");
  const [pickupDate, setPickupDate] = useState(todayPlus(7));
  const [pickupTime, setPickupTime] = useState("10:00");
  const [pickupLocation, setPickupLocation] = useState("");
  const [dropLocation, setDropLocation] = useState("");
  const [travelDate, setTravelDate] = useState(todayPlus(10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<Submitted | null>(null);

  async function submit() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/relocation-enquiry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customerName: name, phonePrimary: phone, phoneSecondary: phoneSecondary || undefined,
          email, petType, relocationKind: kind,
          pickupDate, pickupApproxTime: pickupTime, pickupLocation, dropLocation, expectedTravelDate: travelDate,
        }),
      });
      const body = await response.json() as { data?: { id: string; relocationKind: string }; error?: string };
      if (!response.ok || !body.data) throw new Error(body.error || "Unable to submit the relocation enquiry");
      setDone({ id: body.data.id, relocationKind: body.data.relocationKind ?? kind });
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Unable to submit the relocation enquiry");
    } finally { setBusy(false); }
  }

  if (done) return (
    <section className={styles.confirm}>
      <i>✈</i>
      <h3>Relocation enquiry received</h3>
      <p>Reference <b>{done.id}</b> · {done.relocationKind === "international" ? "International" : "Domestic"} move for your {petType}.</p>
      <p>Our relocation team reviews route, crate, documentation and airline requirements, then calls you with a plan and quote. Nothing is charged now.</p>
    </section>
  );

  return (
    <section className={styles.flow}>
      <header><small>PET RELOCATION · ENQUIRY</small><h3>Move your {petType} safely</h3></header>

      <div className={styles.kind} role="radiogroup" aria-label="Relocation type">
        {(["domestic", "international"] as const).map(option => (
          <button key={option} role="radio" aria-checked={kind === option} className={kind === option ? styles.selected : ""} onClick={() => setKind(option)}>
            <b>{option === "domestic" ? "Domestic" : "International"}</b>
            <small>{option === "domestic" ? "Within India · road or air" : "Cross-border · airline + documentation"}</small>
          </button>
        ))}
      </div>

      <div className={styles.pets}>
        {(["dog", "cat"] as const).map(option => (
          <button key={option} className={petType === option ? styles.selected : ""} onClick={() => setPetType(option)}>
            <i>{option === "dog" ? "🐕" : "🐈"}</i><b>{option === "dog" ? "Dog" : "Cat"}</b>
          </button>
        ))}
      </div>
      <p className={styles.hint}>We currently relocate dogs and cats only.</p>

      <label className={styles.field}>Your name<input value={name} onChange={e => setName(e.target.value)} required /></label>
      <div className={styles.pair}>
        <label className={styles.field}>Primary phone<input value={phone} inputMode="numeric" maxLength={10} onChange={e => setPhone(e.target.value.replace(/\D/g, ""))} required /></label>
        <label className={styles.field}>Secondary (optional)<input value={phoneSecondary} inputMode="numeric" maxLength={10} onChange={e => setPhoneSecondary(e.target.value.replace(/\D/g, ""))} /></label>
      </div>
      <label className={styles.field}>Email<input type="email" value={email} onChange={e => setEmail(e.target.value)} required /></label>
      <div className={styles.pair}>
        <label className={styles.field}>Pickup date<input type="date" value={pickupDate} onChange={e => setPickupDate(e.target.value)} /></label>
        <label className={styles.field}>Approx. time<input type="time" value={pickupTime} onChange={e => setPickupTime(e.target.value)} /></label>
      </div>
      <label className={styles.field}>Pickup location<input value={pickupLocation} placeholder={kind === "domestic" ? "e.g. Indiranagar, Bengaluru" : "e.g. Bengaluru, India"} onChange={e => setPickupLocation(e.target.value)} required /></label>
      <label className={styles.field}>Drop location<input value={dropLocation} placeholder={kind === "domestic" ? "e.g. Andheri West, Mumbai" : "e.g. Singapore"} onChange={e => setDropLocation(e.target.value)} required /></label>
      <label className={styles.field}>Expected travel date<input type="date" value={travelDate} onChange={e => setTravelDate(e.target.value)} /></label>

      {error && <p role="alert" className={styles.error}>{error}</p>}
      <button className={styles.primary} disabled={busy} onClick={() => void submit()}>{busy ? "Submitting…" : "Request relocation plan & quote"}</button>
      <p className={styles.hint}>Free enquiry — the relocation team calls you with the plan. UAT sandbox: no live money.</p>
    </section>
  );
}
