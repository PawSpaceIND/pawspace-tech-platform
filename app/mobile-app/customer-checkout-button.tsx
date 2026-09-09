"use client";
import { useEffect, useRef, useState } from "react";
import { CustomerCheckoutController, type CheckoutState } from "../../lib/customer-checkout-client";
import styles from "./account-tools.module.css";
export default function CustomerCheckoutButton({ bookingId, paymentStatus, onRefresh }: { bookingId: string; paymentStatus: string; onRefresh: () => void }) {
  const [state, setState] = useState<CheckoutState>({ phase: "ready", message: "", canCheck: false });
  const mounted = useRef(true);
  const [controller] = useState(() => new CustomerCheckoutController(bookingId, value => { if (mounted.current) setState(value); }));
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const busy = ["starting", "checkout", "confirming"].includes(state.phase);
  return <div aria-busy={busy}>
    {state.message && <p className={state.phase === "error" ? styles.error : undefined} role={state.phase === "error" ? "alert" : "status"}>{state.message}</p>}
    {!["captured", "settled"].includes(state.phase) && <button type="button" className={styles.button} disabled={busy}
      onClick={() => { void controller.start(); }}>
      {busy ? "Payment in progress…" : state.canCheck ? "Check payment status" : paymentStatus === "captured" ? "Check balance (test)" : "Review & pay (test)"}
    </button>}
    {!busy && state.phase !== "ready" && !state.canCheck && <button type="button" className={styles.button} onClick={onRefresh}>Refresh billing</button>}
  </div>;
}
