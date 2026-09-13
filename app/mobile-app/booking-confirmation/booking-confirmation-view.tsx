"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import CriticalErrorBoundary from "../../components/critical-error-boundary";
import { CustomerCheckoutController, type CheckoutReceipt, type CheckoutState } from "../../../lib/customer-checkout-client";
import { loadCustomerAccount } from "../../../lib/customer-account-client";
import type { CustomerAccountRecord } from "../../../lib/customer-account";
import { customerBookingManageHref } from "../../../lib/customer-activity";
import styles from "./booking-confirmation.module.css";

type Booking = CustomerAccountRecord["bookings"][number];
type Props = { bookingId: string; orderId: string; paymentId: string; signature: string; payment: string; code: string };
const SERVICE_LABEL: Record<string, string> = { grooming: "Grooming", dog_training: "Dog Training", boarding: "Boarding", pet_sitting: "Pet Sitting", pet_taxi: "Pet Taxi", dog_walking: "Dog Walking", food: "Fresh Food", vet_consult: "Vet Consultation" };
const money = (value: number, currency = "INR") => new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
const when = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(date); };
const receiptOf = (p: Props): CheckoutReceipt | null =>
  p.bookingId && /^order_[a-zA-Z0-9_]+$/.test(p.orderId) && /^pay_[a-zA-Z0-9_]+$/.test(p.paymentId) && /^[a-fA-F0-9]{64}$/.test(p.signature)
    ? { bookingId: p.bookingId, orderId: p.orderId, paymentId: p.paymentId, signature: p.signature } : null;

function BookingConfirmationInner(props: Props) {
  const { bookingId } = props;
  const receipt = receiptOf(props);
  const failedReturn = props.payment === "failed";
  const [state, setState] = useState<CheckoutState>({ phase: "ready", message: "", canCheck: false });
  const [booking, setBooking] = useState<Booking | null>(null);
  const [accountError, setAccountError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const controller = useRef<CustomerCheckoutController | null>(null);

  useEffect(() => {
    if (!bookingId) return;
    let active = true;
    const abort = new AbortController();
    void loadCustomerAccount(undefined, { signal: abort.signal }).then(account => {
      if (!active) return;
      setBooking(account.bookings.find(item => item.id === bookingId) || null);
      setAccountError(""); setLoaded(true);
    }).catch(problem => {
      if (!active || abort.signal.aborted) return;
      setAccountError(problem instanceof Error ? problem.message : "Unable to load your booking"); setLoaded(true);
    });
    return () => { active = false; abort.abort(); };
  }, [bookingId, refresh]);

  useEffect(() => {
    if (!bookingId) return;
    let active = true;
    const instance = new CustomerCheckoutController(bookingId, value => {
      if (!active) return;
      setState(value);
      // Once PawSpace verifies the capture, re-read the canonical booking so the confirmed status shows.
      if (value.phase === "captured" || value.phase === "settled") setRefresh(current => current + 1);
    });
    controller.current = instance;
    // A receipt carried back by the Razorpay redirect is verified server-side exactly like the modal
    // handler's. Without one, only the persisted server status is read; nothing is charged here.
    if (!failedReturn) void instance.resume(receipt ?? undefined);
    return () => { active = false; controller.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId, props.orderId, props.paymentId, props.signature, failedReturn]);

  const verified = state.phase === "captured" || state.phase === "settled";
  useEffect(() => {
    if (state.phase !== "pending") return;
    const timer = window.setInterval(() => { void controller.current?.resume(); }, 2500);
    return () => window.clearInterval(timer);
  }, [state.phase]);

  const busy = ["starting", "checkout", "confirming"].includes(state.phase);
  const canPayAgain = !verified && !busy && state.phase !== "pending" && (failedReturn || state.phase === "error" || state.phase === "ready") && (!booking || booking.status === "payment_pending");
  const manageHref = booking ? customerBookingManageHref(booking) : null;
  const serviceName = booking ? SERVICE_LABEL[booking.serviceCode] || booking.serviceCode.replaceAll("_", " ") : "PawSpace";
  const bookingConfirmed = booking ? ["confirmed", "assigned", "in_progress", "completed"].includes(booking.status) : false;

  return <main className={styles.page} data-pawspace-mobile="true"><div className={styles.content}>
    <Link href="/mobile-app">← Back to PawSpace</Link>
    <header><p className={styles.eyebrow}>{verified || bookingConfirmed ? "BOOKING CONFIRMED" : failedReturn ? "PAYMENT NOT COMPLETED" : "PAYMENT RETURN"}</p><h1>{verified || bookingConfirmed ? `Your ${serviceName} booking is confirmed` : `Your ${serviceName} booking`}</h1></header>
    {!bookingId ? <section className={styles.card}><p>Open a booking from your Activity to view its confirmation.</p></section> : <>
      {verified && <section className={`${styles.card} ${styles.success}`} aria-label="Payment verified"><i>✓</i><h2>Payment verified by PawSpace</h2><p>{state.message}</p><p className={styles.reference}>Booking reference · {bookingId}</p></section>}
      {!verified && state.phase === "pending" && <section className={`${styles.card} ${styles.pending}`} aria-label="Payment pending"><h2>Waiting for Razorpay confirmation</h2><p role="status">{state.message}</p><p className={styles.reference}>Booking reference · {bookingId}</p></section>}
      {!verified && failedReturn && state.phase === "ready" && <section className={`${styles.card} ${styles.failed}`} aria-label="Payment failed"><h2>The payment did not go through</h2><p role="alert">Razorpay reported {props.code || "PAYMENT_FAILED"}. Nothing has been confirmed and no money has moved. You can try the payment again below.</p></section>}
      {state.message && !verified && state.phase !== "pending" && !(failedReturn && state.phase === "ready") && <p role={state.phase === "error" ? "alert" : "status"} className={state.phase === "error" ? styles.error : styles.status}>{state.message}</p>}
      {!loaded ? <p role="status" className={styles.status}>Loading your booking…</p> : accountError ? <section className={styles.card}><p role="alert">{accountError}</p><div className={styles.actions}><button type="button" className={styles.secondary} onClick={() => setRefresh(value => value + 1)}>Try again</button><Link className={styles.secondary} href="/mobile-app">Sign in to your account</Link></div></section>
        : !booking ? <section className={styles.card}><h2>Booking unavailable</h2><p>This booking is not on your account. Check that you are signed in to the account that made the booking.</p></section>
        : <section className={styles.card} aria-label="Booking details"><h2>{booking.packageName}</h2><dl>
            <div><dt>Service</dt><dd>{serviceName}</dd></div>
            <div><dt>Status</dt><dd>{booking.status.replaceAll("_", " ")}</dd></div>
            <div><dt>Starts</dt><dd>{when(booking.scheduledStart)} IST</dd></div>
            <div><dt>Booking total</dt><dd>{money(booking.totalAmount, booking.currency)}</dd></div>
          </dl><p className={styles.reference}>Booking reference · {booking.id}</p></section>}
      <div className={styles.actions}>
        {canPayAgain && <button type="button" className={styles.primary} disabled={busy} onClick={() => void controller.current?.start()}>Pay securely with Razorpay</button>}
        {!verified && state.canCheck && !busy && state.phase !== "pending" && <button type="button" className={styles.secondary} onClick={() => void controller.current?.resume()}>Check payment status</button>}
        {manageHref && <Link className={styles.secondary} href={manageHref}>Manage this booking</Link>}
        <Link className={verified || bookingConfirmed ? styles.primary : styles.secondary} href="/mobile-app">Continue to PawSpace</Link>
      </div>
      <small className={styles.foot}>The browser never self-confirms a payment. Signed gateway evidence remains authoritative; if Razorpay has taken the payment, this page updates once PawSpace verifies it.</small>
    </>}
  </div></main>;
}

export default function BookingConfirmationView(props: Props) {
  return <CriticalErrorBoundary name="Booking Confirmation" resetHref="/mobile-app"><BookingConfirmationInner {...props} /></CriticalErrorBoundary>;
}
