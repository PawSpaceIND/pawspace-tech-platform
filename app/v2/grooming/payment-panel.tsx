"use client";
/* eslint-disable @next/next/no-img-element, react-hooks/set-state-in-effect */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  createV2GroomingCheckoutController, isV2GroomingConfirmationReady,
  loadV2GroomingCheckoutReadiness, saveV2GroomingDoorstep,
  type CheckoutState, type CustomerConfirmationProjection, type V2GroomingCheckoutReadiness,
} from "../../../lib/v2/grooming-checkout-client";
import { returnToBooking } from "../../../lib/customer-checkout-client";
import { formatIndiaDateTimeMedium } from "../../../lib/india-time";
import styles from "./grooming.module.css";

const when = (value: string) => Number.isFinite(Date.parse(value))
  ? formatIndiaDateTimeMedium(value) : "Verifying time";
const money = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(value);

type Props = { bookingId: string; initialAddress?: string; initialPincode?: string; preparing?: boolean };
export default function V2GroomingPaymentPanel({ bookingId, initialAddress = "", initialPincode = "", preparing = false }: Props) {
  const [projection, setProjection] = useState<CustomerConfirmationProjection | null>(null);
  const [readiness, setReadiness] = useState<V2GroomingCheckoutReadiness | null>(null);
  const [state, setState] = useState<CheckoutState>({ phase: "ready", message: "Checking your booking directly with PawSpace.", canCheck: false });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [address, setAddress] = useState(initialAddress), [pincode, setPincode] = useState(initialPincode);
  const [refresh, setRefresh] = useState(0), [polling, setPolling] = useState(true);
  const [attempted, setAttempted] = useState(false);
  const mounted = useRef(false), actionBusy = useRef(false);
  const controller = useRef<ReturnType<typeof createV2GroomingCheckoutController> | null>(null);

  useEffect(() => {
    mounted.current = true;
    controller.current = createV2GroomingCheckoutController(bookingId, next => {
      if (!mounted.current) return;
      setState(next);
      if (["captured", "settled", "pending", "error"].includes(next.phase)) setRefresh(value => value + 1);
    });
    const url = new URL(window.location.href);
    const orderId = url.searchParams.get("orderId") || "", paymentId = url.searchParams.get("paymentId") || "";
    const signature = url.searchParams.get("signature") || "";
    const returned = url.searchParams.get("payment");
    for (const field of ["orderId", "paymentId", "signature", "payment", "code"]) url.searchParams.delete(field);
    window.history.replaceState(window.history.state, "", url.pathname + url.search);
    if (returned === "returned" && /^order_[a-zA-Z0-9_]+$/.test(orderId) && /^pay_[a-zA-Z0-9_]+$/.test(paymentId) && /^[a-fA-F0-9]{64}$/.test(signature)) {
      setAttempted(true);
      void controller.current.resume({ bookingId, orderId, paymentId, signature });
    }
    return () => { mounted.current = false; controller.current = null; };
  }, [bookingId]);

  useEffect(() => {
    let active = true, reading = false, attempts = 0;
    const read = async () => {
      if (!active || reading) return;
      reading = true;
      try {
        const nextReadiness = await loadV2GroomingCheckoutReadiness(bookingId);
        const next = nextReadiness.confirmation;
        if (!active) return;
        if (next.serviceCode !== "grooming") throw new Error("This is not a Grooming checkout.");
        setReadiness(nextReadiness); setProjection(next); setError("");
        if (isV2GroomingConfirmationReady(next, bookingId) || ["cancelled", "refunded", "completed"].includes(next.bookingStatus)) {
          active = false; clearInterval(timer); setPolling(false);
        }
      } catch (problem) {
        if (active) { setError(problem instanceof Error ? problem.message : "Unable to read your booking."); setReadiness(null); }
      } finally {
        reading = false;
        if (active && ++attempts >= 24) { active = false; clearInterval(timer); setPolling(false); }
      }
    };
    const timer = setInterval(() => { void read(); }, 2500);
    // Bounded, non-overlapping reads; no reservation or gateway order is created by refresh/reload.
    void read();
    return () => { active = false; clearInterval(timer); };
  }, [bookingId, refresh]);

  const confirmed = isV2GroomingConfirmationReady(projection, bookingId);
  useEffect(()=>{
    if(confirmed&&attempted)returnToBooking(bookingId);
  },[confirmed,attempted,bookingId]);
  const paymentVerified = projection?.paymentStatus === "captured" || state.phase === "captured" || state.phase === "settled";
  const canPay = !preparing && !busy && !error && readiness?.locationReady === true &&
    projection?.bookingStatus === "payment_pending" && ["created", "authorised"].includes(projection.paymentStatus) &&
    !paymentVerified && !(attempted && state.phase === "pending");

  async function pay() {
    if (actionBusy.current || !canPay) return;
    actionBusy.current = true; setBusy(true); setError("");
    try {
      // Re-read both boundaries immediately before any payment action; never rely on an old render.
      const current = await loadV2GroomingCheckoutReadiness(bookingId), canonical = current.confirmation;
      if (!mounted.current) return;
      setReadiness(current); setProjection(canonical);
      if (canonical.paymentStatus === "captured" || isV2GroomingConfirmationReady(canonical, bookingId)) return;
      if (!current.locationReady || canonical.serviceCode !== "grooming" || canonical.bookingStatus !== "payment_pending" ||
          !["created", "authorised"].includes(canonical.paymentStatus)) throw new Error("This booking is not ready for a new payment. Check its verified status.");
      setAttempted(true);
      await controller.current?.start();
    } catch (problem) { if (mounted.current) setError(problem instanceof Error ? problem.message : "Unable to open checkout."); }
    finally { actionBusy.current = false; if (mounted.current) { setBusy(false); setRefresh(value => value + 1); } }
  }

  async function saveDoorstep() {
    if (!readiness || actionBusy.current) return;
    actionBusy.current = true; setBusy(true); setError("");
    try { await saveV2GroomingDoorstep(bookingId, readiness.customerId, address, pincode); }
    catch (problem) { if (mounted.current) setError(problem instanceof Error ? problem.message : "Unable to verify this doorstep."); }
    finally { actionBusy.current = false; if (mounted.current) { setBusy(false); setRefresh(value => value + 1); } }
  }

  return <main className={styles.checkoutPage}><section className={styles.checkoutCard} aria-label="Grooming checkout">
    <Link href="/v2" className={styles.checkoutBrand}><img src="/assets/pawspace-official-lockup.png" alt="PawSpace" /></Link>
    <span className={styles.eyebrow}>{confirmed ? "BOOKING CONFIRMED" : "YOUR GROOMING BOOKING"}</span>
    <h1>{confirmed ? "A lovely spa day is on its way." : paymentVerified ? "Payment verified. Finalizing your visit." : "One step closer to their spa day."}</h1>
    <p role="status">{confirmed ? "Your care details below are confirmed by PawSpace." : preparing ? "Saving your verified doorstep before payment." : state.message}</p>
    <div className={styles.checkoutFacts}>
      <div><span>Booking reference</span><b>{bookingId}</b></div>
      <div><span>Care professional</span><b>{projection?.providerName || "Verifying professional"}</b></div>
      <div><span>Package</span><b>{projection?.packageName || "Verifying package"}</b></div>
      <div><span>Booking total</span><b>{projection && Number.isFinite(projection.totalAmount) ? money(projection.totalAmount) : "Verifying amount"}</b></div>
      <div><span>Exact visit time (IST)</span><b>{projection ? `${when(projection.scheduledStart)} - ${when(projection.scheduledEnd)}` : "Verifying time"}</b></div>
      <div><span>Payment reference</span><b>{projection?.transactionId || "Awaiting verified payment"}</b></div>
    </div>
    {confirmed ? <div className={styles.confirmedBox} role="status"><span aria-hidden="true">&#10003;</span><div><b>Your grooming visit is confirmed</b><small>{projection?.pets?.map(pet => pet.name).join(" + ")}</small></div></div>
      : <div className={styles.safe}><span aria-hidden="true">&#9670;</span><p><b>Verify-first payment.</b> The browser never declares success. We wait for your verified payment, exact slot and care professional to agree on the server.</p></div>}
    {!preparing && readiness && !readiness.locationReady && projection?.bookingStatus === "payment_pending" && !paymentVerified && <form className={styles.recoveryForm} onSubmit={event => { event.preventDefault(); void saveDoorstep(); }}>
      <h2>Verify the doorstep for this booking</h2><p>Your booking reference is preserved. No second booking is needed.</p>
      <label>House, street &amp; area<input required minLength={8} value={address} onChange={event => setAddress(event.target.value)} autoComplete="street-address" /></label>
      <label>PIN code<input required pattern="[1-9][0-9]{5}" inputMode="numeric" value={pincode} onChange={event => setPincode(event.target.value.replace(/\D/g, "").slice(0, 6))} autoComplete="postal-code" /></label>
      <button type="submit" className={styles.statusButton} disabled={busy}>Save verified doorstep</button>
    </form>}
    {error && <p className={styles.inlineError} role="alert">{error}</p>}
    {state.phase === "error" && <p className={styles.inlineError} role="alert">{state.message}</p>}
    {!confirmed && <div className={styles.checkoutActions}>
      <button type="button" className={styles.continue} disabled={!canPay} onClick={() => void pay()}>{busy ? "Checking securely..." : paymentVerified ? "Payment received - do not pay again" : "Pay securely with Razorpay"}</button>
      <button type="button" className={styles.statusButton} disabled={busy} onClick={() => { setPolling(true); setRefresh(value => value + 1); void controller.current?.resume(); }}>Check verified status</button>
      {!polling && <p>Automatic checks have paused. Check status again; keep this booking reference rather than paying again.</p>}
    </div>}
    <Link href="/v2" className={styles.doneLink}>Back to PawSpace</Link>
    <small className={styles.receiptNote}>Sandbox checkout only. Reloading this page reads the same booking and never creates a payment.</small>
  </section></main>;
}
