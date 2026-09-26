"use client";
import { useEffect, useRef, useState } from "react";
import { CustomerCheckoutController, returnToBooking, type CheckoutState } from "../../lib/customer-checkout-client";
import styles from "./account-tools.module.css";
import CriticalErrorBoundary from "../components/critical-error-boundary";
function CustomerCheckoutButtonInner({ bookingId, paymentStatus, onRefresh }: { bookingId: string; paymentStatus: string; onRefresh: () => void }) {
  const [state, setState] = useState<CheckoutState>({ phase: "ready", message: "", canCheck: false });
  const controller = useRef<CustomerCheckoutController | null>(null);
  useEffect(() => {
    let active = true;
    const instance = new CustomerCheckoutController(bookingId, value => { if (active) { setState(value); if(value.phase === "captured") returnToBooking(bookingId); } });
    controller.current = instance;
    return () => { active = false; controller.current = null; };
  }, [bookingId]);
  const busy = ["starting", "checkout", "confirming"].includes(state.phase);
  const waiting = state.phase === "pending";
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => { void controller.current?.start(); }, 2500);
    return () => window.clearInterval(timer);
  }, [waiting]);
  return <div aria-busy={busy||waiting}>
    {state.message && <p className={state.phase === "error" ? styles.error : undefined} role={state.phase === "error" ? "alert" : "status"}>{state.message}</p>}
    {!["captured", "settled"].includes(state.phase) && <button type="button" className={styles.button} disabled={busy||waiting}
      onClick={() => { void controller.current?.start(); }}>
      {waiting ? "Waiting for payment confirmation…" : busy ? "Payment in progress…" : state.canCheck ? "Check payment status" : paymentStatus === "captured" ? "Check balance (test)" : "Review & pay (test)"}
    </button>}
    {!busy && state.phase !== "ready" && !state.canCheck && <button type="button" className={styles.button} onClick={onRefresh}>Refresh billing</button>}
  </div>;
}

export default function CustomerCheckoutButton(props:{bookingId:string;paymentStatus:string;onRefresh:()=>void}){return <CriticalErrorBoundary name="Payment Screen"><CustomerCheckoutButtonInner {...props}/></CriticalErrorBoundary>;}
