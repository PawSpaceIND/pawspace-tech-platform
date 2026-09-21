"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CustomerCheckoutController, loadCustomerConfirmationProjection, type CheckoutState, type CustomerConfirmationProjection } from "../../../lib/customer-checkout-client";
import { customerBookingManageHref } from "../../../lib/customer-activity";
import { useQueryParameter } from "../../../lib/use-query-parameter";
import styles from "../customer-detail.module.css";

// CUST-L-D04: this page used to load the booking through POST /api/customer-checkout {action:"status"},
// which threw a 503 whenever the Razorpay sandbox key was unconfigured — a gateway/config outage hid
// the whole booking record behind "Razorpay test checkout is not configured. Contact billing support."
// The fix in app/api/customer-checkout/route.ts scopes that gate to {action:"start"} only, since
// "status" is a read of PawSpace's own canonical_bookings/booking_payments record and needs no gateway
// at all. This page reads that same owned projection; a payment-gateway refusal is now only possible
// from an explicit "Pay securely" attempt below, and renders ALONGSIDE the booking card, not instead
// of it.
const SERVICE_LABEL: Record<string, string> = { grooming: "Grooming", dog_training: "Dog Training", boarding: "Boarding", pet_sitting: "Pet Sitting", pet_taxi: "Pet Taxi", dog_walking: "Dog Walking", food: "Fresh Food", vet_consult: "Vet Consultation" };
const label = (v: string) => v.replaceAll("_", " ");
const money = (v: number, c: string) => new Intl.NumberFormat("en-IN", { style: "currency", currency: c, maximumFractionDigits: 0 }).format(v);
const when = (v: string) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? "Schedule pending" : new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(d); };

export default function V2BookingPage() {
  const bookingId = useQueryParameter("bookingId");
  const [projection, setProjection] = useState<CustomerConfirmationProjection | null>(null);
  const [projectionError, setProjectionError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [checkoutState, setCheckoutState] = useState<CheckoutState>({ phase: "ready", message: "", canCheck: false });
  const controller = useRef<CustomerCheckoutController | null>(null);

  useEffect(() => {
    if (!bookingId) return;
    let live = true;
    void loadCustomerConfirmationProjection(bookingId).then(value => {
      if (!live) return;
      setProjection(value); setProjectionError(""); setLoaded(true);
    }).catch(problem => {
      if (!live) return;
      setProjection(null); setProjectionError(problem instanceof Error ? problem.message : "Unable to load your booking"); setLoaded(true);
    });
    return () => { live = false; };
  }, [bookingId, refresh]);

  useEffect(() => {
    if (!bookingId) return;
    let live = true;
    controller.current = new CustomerCheckoutController(bookingId, value => { if (live) setCheckoutState(value); });
    return () => { live = false; controller.current = null; };
  }, [bookingId]);

  const manageHref = projection ? customerBookingManageHref({ id: projection.bookingId, serviceCode: projection.serviceCode, scheduledStart: projection.scheduledStart, status: projection.bookingStatus }) : null;
  const serviceName = projection ? (SERVICE_LABEL[projection.serviceCode] || label(projection.serviceCode)) : "PawSpace";
  const paymentPending = projection?.bookingStatus === "payment_pending";
  const busy = ["starting", "checkout", "confirming"].includes(checkoutState.phase);

  return <main className={styles.page}><div className={styles.shell}>
    <header className={styles.topbar}><Link href="/v2" className={styles.brand}><img src="/assets/pawspace-icon.jpeg" alt="" /><span>PawSpace</span></Link><Link href="/v2/activity" className={styles.back}>← Your bookings</Link></header>
    <section className={styles.hero}><span className={styles.eyebrow}>BOOKING & PAYMENT</span><h1>{serviceName}</h1></section>
    {!bookingId ? <section className={styles.card}><p>Open a booking from your Activity to view its booking and payment record.</p><Link href="/v2/activity" className={styles.back}>← Your bookings</Link></section>
      : !loaded ? <section className={styles.card}>Loading your booking…</section>
      : projectionError ? <section className={styles.card}><p role="alert">{projectionError}</p><div className={styles.actions}><button type="button" className={styles.primary} onClick={() => { setProjectionError(""); setRefresh(v => v + 1); }}>Retry booking</button><Link className={styles.back} href="/v2/activity">← Your bookings</Link></div></section>
      : !projection ? <section className={styles.card}><p>This booking is not on your account.</p><Link href="/v2/activity" className={styles.back}>← Your bookings</Link></section>
      : <section className={styles.card} aria-label="Booking details">
          <h2>{projection.packageName || serviceName}</h2>
          <p className={styles.muted}>Booking reference · {projection.bookingId}</p>
          <span className={styles.pill}>{label(projection.bookingStatus)}</span>
          <p>{when(projection.scheduledStart)} – {when(projection.scheduledEnd)}</p>
          {projection.providerName && <p className={styles.muted}>Assigned partner · {projection.providerName}{projection.providerModel ? ` · ${label(projection.providerModel)}` : ""}</p>}
          {(projection.pets?.length ?? 0) > 0 && <p className={styles.muted}>{projection.pets?.length === 1 ? "Pet" : "Pets"} · {projection.pets?.map(pet => pet.name).join(", ")}</p>}
          <p className={styles.money}>{money(projection.totalAmount, projection.currency)}</p>
          <p className={styles.muted}>Payment · {label(projection.paymentStatus)}{projection.amountDueNow > 0 ? ` · ${money(projection.amountDueNow, projection.currency)} due now` : ""}</p>
          {checkoutState.message && <p role={checkoutState.phase === "error" ? "alert" : "status"} className={checkoutState.phase === "error" ? styles.danger : styles.muted}>{checkoutState.message}</p>}
          <div className={styles.actions}>
            {manageHref && <Link className={styles.primary} href={manageHref}>Manage service</Link>}
            {paymentPending && <button type="button" className={styles.primary} disabled={busy} onClick={() => void controller.current?.start()}>{busy ? "Preparing secure payment…" : "Pay securely"}</button>}
          </div>
        </section>}
    <nav className={styles.dock} aria-label="PawSpace V2 navigation"><Link href="/v2"><strong>⌂</strong>Home</Link><Link href="/v2/grooming"><strong>＋</strong>Book</Link><Link href="/v2/activity" className={styles.active}><strong>◎</strong>Activity</Link><Link href="/v2/account"><strong>◉</strong>Account</Link></nav>
  </div></main>;
}
