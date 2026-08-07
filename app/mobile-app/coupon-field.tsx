"use client";

import { useState } from "react";
import { validateOffer, type CustomerKind, type PawspaceService } from "../../lib/offer-engine";
import styles from "./coupon-field.module.css";

export default function CouponField({
  eligible = true,
  service,
  orderValue,
  customerKind = "existing",
  orderCount = 2,
  isSubscription = false,
  paymentMode = "full",
  onDiscountChange,
}: {
  eligible?: boolean;
  service: PawspaceService;
  orderValue: number;
  customerKind?: CustomerKind;
  orderCount?: number;
  isSubscription?: boolean;
  paymentMode?: "full" | "partial" | "after_service";
  onDiscountChange: (discount: number, code: string) => void;
}) {
  const [code, setCode] = useState("");
  const [applied, setApplied] = useState("");
  const [message, setMessage] = useState("");

  const apply = () => {
    const normalized = code.trim().toUpperCase();
    const result = validateOffer({code:normalized,service,orderValue,customerKind,orderCount,isSubscription,paymentMode,city:"Bengaluru",channel:"Customer app"});
    setApplied(result.valid ? result.code : "");
    setMessage(result.message);
    onDiscountChange(result.discount, result.code);
  };

  return (
    <section className={`${styles.coupon} ${!eligible ? styles.disabled : ""}`}>
      <header>
        <div>
          <b>Coupon or referral code</b>
          <span>{eligible ? "Customer, order, service and usage rules are checked" : "Available with full payment"}</span>
        </div>
        {applied && <em>APPLIED</em>}
      </header>
      <label>
        <input
          value={code}
          disabled={!eligible}
          onChange={(event) => setCode(event.target.value)}
          placeholder={eligible ? "PAW100 or referral code" : "Choose 100% payment to apply"}
          aria-label="Coupon or referral code"
        />
        <button type="button" disabled={!eligible || !code.trim()} onClick={apply}>
          Apply
        </button>
      </label>
      {message && <small className={applied ? styles.success : styles.error}>{message}</small>}
    </section>
  );
}
