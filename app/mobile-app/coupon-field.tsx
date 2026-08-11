"use client";

import { useState } from "react";
import { quoteGovernedCoupon } from "../../lib/coupon-governance-client";
import type { CustomerKind, PawspaceService } from "../../lib/offer-engine";
import styles from "./coupon-field.module.css";

const serviceCodes: Record<PawspaceService, "grooming" | "dog_training" | "boarding" | "pet_sitting"> = {
  Grooming: "grooming",
  "Dog Training": "dog_training",
  Boarding: "boarding",
  "Pet Sitting": "pet_sitting",
};

export default function CouponField(props: {
  eligible?: boolean;
  service: PawspaceService;
  orderValue: number;
  customerKind?: CustomerKind;
  orderCount?: number;
  isSubscription?: boolean;
  paymentMode?: "full" | "partial" | "after_service";
  customerId?: string;
  cityId?: string;
  channel?: "customer_app" | "website" | "assisted_staff" | "whatsapp" | "partner_app";
  packageCode?: string;
  onDiscountChange: (discount: number, code: string, quoteId?: string) => void;
}) {
  const {
    eligible = true,
    service,
    orderValue,
    isSubscription = false,
    paymentMode = "full",
    customerId,
    cityId = "blr",
    channel = "customer_app",
    packageCode = "uat-default",
    onDiscountChange,
  } = props;
  const [code, setCode] = useState("");
  const [applied, setApplied] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const apply = async () => {
    const normalized = code.trim().toUpperCase();
    if (!normalized || loading) return;
    if (!customerId) { setError("Sign in required before applying a coupon"); return; }
    setLoading(true);
    try {
      const result = await quoteGovernedCoupon({
        code: normalized,
        customerId,
        serviceCode: serviceCodes[service],
        cityId,
        channel,
        packageCode,
        orderValue,
        paymentMode,
        isSubscription,
      });
      if (!result.valid || !result.code) {
        setApplied("");
        setMessage(result.error || "Coupon is not eligible for this booking");
        onDiscountChange(0, "");
        return;
      }
      setApplied(result.code);
      setMessage(`UAT coupon applied · you save ₹${result.discount}`);
      onDiscountChange(result.discount, result.code, result.quoteId);
    } catch (error) {
      setApplied("");
      setMessage(error instanceof Error ? error.message : "Unable to validate coupon");
      onDiscountChange(0, "");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className={`${styles.coupon} ${!eligible ? styles.disabled : ""}`}>
      <header>
        <div>
          <b>Coupon code · UAT governed</b>
          <span>{eligible ? "Eligibility, limits and discount are checked by the server" : "Available with full payment"}</span>
        </div>
        {applied && <em>APPLIED</em>}
      </header>
      <label>
        <input
          value={code}
          disabled={!eligible || loading}
          onChange={(event) => setCode(event.target.value)}
          placeholder={eligible ? "UATCARE100" : "Choose 100% payment to apply"}
          aria-label="Coupon code"
        />
        <button type="button" disabled={!eligible || !code.trim() || loading} onClick={apply}>
          {loading ? "Checking…" : "Apply"}
        </button>
      </label>
      {message && <small className={applied ? styles.success : styles.error}>{message}</small>}
    </section>
  );
}
