"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import CriticalErrorBoundary from "../../components/critical-error-boundary";
import { CustomerCheckoutController, loadCustomerConfirmationProjection, type CheckoutReceipt, type CheckoutState, type CustomerConfirmationProjection } from "../../../lib/customer-checkout-client";
import { customerBookingManageHref } from "../../../lib/customer-activity";
import { customerScopedHref } from "../../../lib/v2/route-scope";
import styles from "./booking-confirmation.module.css";

type Props = { bookingId: string; orderId: string; paymentId: string; signature: string; payment: string; code: string; routeScope?: "legacy" | "v2" };
const SERVICE_LABEL: Record<string, string> = { grooming: "Grooming", dog_training: "Dog Training", boarding: "Boarding", pet_sitting: "Pet Sitting", pet_taxi: "Pet Taxi", dog_walking: "Dog Walking", food: "Fresh Food", vet_consult: "Vet Consultation" };
const money = (value: number, currency = "INR") => new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
const when = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(date); };
const receiptOf = (p: Props): CheckoutReceipt | null =>
  p.bookingId && /^order_[a-zA-Z0-9_]+$/.test(p.orderId) && /^pay_[a-zA-Z0-9_]+$/.test(p.paymentId) && /^[a-fA-F0-9]{64}$/.test(p.signature)
    ? { bookingId: p.bookingId, orderId: p.orderId, paymentId: p.paymentId, signature: p.signature } : null;

function BookingConfirmationInner(props: Props) {
  const { bookingId } = props;
  const home = props.routeScope === "v2" ? "/v2" : "/mobile-app";
  const receipt = receiptOf(props);
  const failedReturn = props.payment === "failed";
  const [state, setState] = useState<CheckoutState>({ phase: "ready", message: "", canCheck: false });
  const [projection, setProjection] = useState<CustomerConfirmationProjection | null>(null);
  const [projectionError, setProjectionError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const controller = useRef<CustomerCheckoutController | null>(null);

  useEffect(() => {
    if (!bookingId) return;
    let active = true;
    const abort = new AbortController();
    void loadCustomerConfirmationProjection(bookingId, abort.signal).then(value => {
      if (!active) return;
      setProjection(value); setProjectionError(""); setLoaded(true);
    }).catch(problem => {
      if (!active || abort.signal.aborted) return;
      setProjectionError(problem instanceof Error ? problem.message : "Unable to load your booking"); setLoaded(true);
    });
    return () => { active = false; abort.abort(); };
  }, [bookingId, refresh]);

  useEffect(() => {
    if (!bookingId) return;
    let active = true;
    const instance = new CustomerCheckoutController(bookingId, value => {
      if (!active) return;
      setState(value);
      // Once PawSpace verifies the capture, re-read the customer-owned projection. The callback receipt
      // never supplies success-screen details.
      if (value.phase === "captured" || value.phase === "settled") setRefresh(current => current + 1);
    });
    controller.current = instance;
    // A receipt carried back by the Razorpay redirect is verified server-side exactly like the modal
    // handler's. Without one, only the persisted server status is read; nothing is charged here.
    // A failed return still probes that status once, so a retry is never offered for money Razorpay
    // already took, without parking a genuinely failed attempt in the waiting state.
    if (failedReturn) void instance.probeStatus(); else void instance.resume(receipt ?? undefined);
    return () => { active = false; controller.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId, props.orderId, props.paymentId, props.signature, failedReturn]);

  const verified = state.phase === "captured" || state.phase === "settled";
  useEffect(() => {
    if (state.phase !== "pending") return;
    const timer = window.setInterval(() => { void controller.current?.resume(); }, 2500);
    return () => window.clearInterval(timer);
  }, [state.phase]);

  // Payment capture and booking/work-order writes can settle a few moments apart. Keep the success
  // screen closed until one server projection contains the exact canonical slot, provider and payment.
  useEffect(() => {
    if (!bookingId || projection?.ready) return;
    const timer = window.setInterval(() => setRefresh(value => value + 1), 2500);
    return () => window.clearInterval(timer);
  }, [bookingId, projection?.ready]);

  const busy = ["starting", "checkout", "confirming"].includes(state.phase);
  const canPayAgain = loaded && !verified && !busy && state.phase !== "pending" && (failedReturn || state.phase === "error" || state.phase === "ready") && (!projection || projection.bookingStatus === "payment_pending");
  const manageHref = projection ? customerBookingManageHref({id:projection.bookingId,serviceCode:projection.serviceCode,scheduledStart:projection.scheduledStart,status:projection.bookingStatus}) : null;
  const serviceName = projection ? SERVICE_LABEL[projection.serviceCode] || projection.serviceCode.replaceAll("_", " ") : "PawSpace";
  const canonicalReady = Boolean(projection?.ready);
  const success = verified && canonicalReady;

  return <main className={styles.page} data-pawspace-mobile="true"><div className={styles.content}>
    <Link href={home}>← Back to PawSpace</Link>
    <header><p className={styles.eyebrow}>{success ? "BOOKING CONFIRMED" : failedReturn ? "PAYMENT NOT COMPLETED" : "PAYMENT RETURN"}</p><h1>{success ? `Your ${serviceName} booking is confirmed` : `Your ${serviceName} booking`}</h1></header>
    {!bookingId ? <section className={styles.card}><p>Open a booking from your Activity to view its confirmation.</p></section> : <>
      {success && <section className={`${styles.card} ${styles.success}`} aria-label="Payment verified"><i>✓</i><h2>Payment verified by PawSpace</h2><p>{state.message}</p><p className={styles.reference}>Booking reference · {bookingId}</p></section>}
      {verified && !canonicalReady && <section className={`${styles.card} ${styles.pending}`} aria-label="Confirmation synchronizing"><h2>Finalizing your confirmed booking</h2><p role="status">Payment is verified. PawSpace is reading the assigned provider, exact slot and transaction directly from the server before showing success.</p></section>}
      {!verified && state.phase === "pending" && <section className={`${styles.card} ${styles.pending}`} aria-label="Payment pending"><h2>Waiting for Razorpay confirmation</h2><p role="status">{state.message}</p><p className={styles.reference}>Booking reference · {bookingId}</p></section>}
      {!verified && failedReturn && state.phase === "ready" && <section className={`${styles.card} ${styles.failed}`} aria-label="Payment failed"><h2>The payment did not go through</h2><p role="alert">Razorpay reported {props.code || "PAYMENT_FAILED"}. PawSpace has not verified a successful payment. If your bank shows a debit, check payment status or contact support before retrying.</p></section>}
      {state.message && !verified && state.phase !== "pending" && !(failedReturn && state.phase === "ready") && <p role={state.phase === "error" ? "alert" : "status"} className={state.phase === "error" ? styles.error : styles.status}>{state.message}</p>}
      {!loaded ? <p role="status" className={styles.status}>Loading your booking…</p> : projectionError ? <section className={styles.card}><p role="alert">{projectionError}</p><div className={styles.actions}><button type="button" className={styles.secondary} onClick={() => { setProjectionError(""); setLoaded(false); setRefresh(value => value + 1); }}>Try again</button><Link className={styles.secondary} href={home}>Sign in to your account</Link></div></section>
        : !projection ? <section className={styles.card}><h2>Booking unavailable</h2><p>This booking is not on your account. Check that you are signed in to the account that made the booking.</p></section>
        : <section className={styles.card} aria-label="Booking details"><h2>{projection.packageName}</h2><dl>
            <div><dt>Service</dt><dd>{serviceName}</dd></div>
            <div><dt>Status</dt><dd>{projection.bookingStatus.replaceAll("_", " ")}</dd></div>
            <div><dt>Exact slot</dt><dd>{when(projection.scheduledStart)} – {when(projection.scheduledEnd)} IST</dd></div>
            <div><dt>Assigned provider</dt><dd>{projection.providerName} · {projection.providerModel.replaceAll("_", " ")}</dd></div>
            {(projection.pets?.length ?? 0) > 0 && <div><dt>{projection.pets?.length === 1 ? "Pet" : "Pets"}</dt><dd>{projection.pets?.map(pet => `${pet.name}${pet.breed ? ` · ${pet.breed}` : ` · ${pet.species}`}`).join(", ")}</dd></div>}
            <div><dt>Payment</dt><dd>{projection.paymentStatus.replaceAll("_", " ")}</dd></div>
            <div><dt>Transaction ID</dt><dd>{projection.transactionId || (projection.paymentMode === "pay_after_service" ? "Not applicable · pay after service" : "Synchronizing")}</dd></div>
            <div><dt>Booking total</dt><dd>{money(projection.totalAmount, projection.currency)}</dd></div>
          </dl><p className={styles.reference}>Booking reference · {projection.bookingId}</p></section>}
      {verified && projection && <section className={styles.card} aria-label="Payment receipt"><h2>Payment receipt</h2><dl>
        <div><dt>Status</dt><dd>{projection.paymentStatus.replaceAll("_", " ")}</dd></div>
        <div><dt>Amount</dt><dd>{money(projection.totalAmount, projection.currency)}</dd></div>
        {projection.gatewayPaymentId && <div><dt>Razorpay payment</dt><dd>{projection.gatewayPaymentId}</dd></div>}
        {projection.gatewayOrderId && <div><dt>Razorpay order</dt><dd>{projection.gatewayOrderId}</dd></div>}
      </dl><p className={styles.reference}>PawSpace payment record · {projection.paymentId}</p></section>}
      <div className={styles.actions}>
        {canPayAgain && <button type="button" className={styles.primary} disabled={busy} onClick={() => void controller.current?.start()}>Pay securely with Razorpay</button>}
        {!verified && state.canCheck && !busy && state.phase !== "pending" && <button type="button" className={styles.secondary} onClick={() => void controller.current?.resume()}>Check payment status</button>}
        {manageHref && <Link className={styles.secondary} href={customerScopedHref(home, manageHref)}>Manage this booking</Link>}
        <Link className={success ? styles.primary : styles.secondary} href={home}>Continue to PawSpace</Link>
      </div>
      <small className={styles.foot}>The browser never self-confirms a payment. Signed gateway evidence remains authoritative; if Razorpay has taken the payment, this page updates once PawSpace verifies it.</small>
    </>}
  </div></main>;
}

export default function BookingConfirmationView(props: Props) {
  return <CriticalErrorBoundary name="Booking Confirmation" resetHref={props.routeScope === "v2" ? "/v2" : "/mobile-app"}><BookingConfirmationInner {...props} /></CriticalErrorBoundary>;
}
