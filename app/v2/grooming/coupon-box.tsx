"use client";
import { useRef, useState } from "react";
import { quoteGovernedCoupon } from "../../../lib/coupon-governance-client";
import styles from "./grooming.module.css";

type Props = {
  customerId: string;
  cityId: string;
  packageCode: string;
  orderValue: number;
  onChange: (discount: number, code: string, quoteId?: string) => void;
};

/**
 * A coupon for this exact live price. The server quotes the discount (eligibility, city, package, limits)
 * and the booking re-checks and consumes that quote. The page remounts this box whenever the price,
 * package or slot changes, so an applied code never carries over to a different basket.
 */
export default function V2GroomingCouponBox({ customerId, cityId, packageCode, orderValue, onChange }: Props) {
  const [code, setCode] = useState(""), [applied, setApplied] = useState(""), [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const version = useRef(0);
  const apply = async () => {
    const normalized = code.trim().toUpperCase();
    if (!normalized || busy) return;
    const current = ++version.current;
    setBusy(true); setApplied(""); setMessage(""); onChange(0, normalized);
    try {
      const result = await quoteGovernedCoupon({ code: normalized, customerId, serviceCode: "grooming", cityId, channel: "website", packageCode, orderValue, paymentMode: "full", isSubscription: false });
      if (current !== version.current) return;
      if (!result.valid || !result.code || !result.quoteId) { onChange(0, ""); setMessage(result.error || "This coupon is not eligible for this booking."); return; }
      setApplied(result.code); setMessage(`${result.code} applied. You save ₹${result.discount}.`);
      onChange(result.discount, result.code, result.quoteId);
    } catch (problem) {
      if (current !== version.current) return;
      onChange(0, ""); setMessage(problem instanceof Error ? problem.message : "We could not check this coupon.");
    } finally { if (current === version.current) setBusy(false); }
  };
  return (
    <div className={styles.addressBox} role="group" aria-label="Coupon code">
      <label>Coupon code<input value={code} disabled={busy} placeholder="GROOM200" onChange={event => { version.current++; setBusy(false); setCode(event.target.value); setApplied(""); setMessage(""); onChange(0, ""); }} /></label>
      <button type="button" disabled={busy || !code.trim()} onClick={() => void apply()}>{busy ? "Checking…" : applied ? "Applied" : "Apply"}</button>
      {message && <p role={applied ? "status" : "alert"} className={applied ? styles.helper : styles.inlineError}>{message}</p>}
    </div>
  );
}
