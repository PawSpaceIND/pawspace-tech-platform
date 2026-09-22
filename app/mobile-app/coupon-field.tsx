"use client";

import { useEffect, useRef, useState } from "react";
import { quoteGovernedCoupon } from "../../lib/coupon-governance-client";
import { droppedCouponReport } from "../../lib/coupon-reapply-guard";
import type { CustomerKind, PawspaceService } from "../../lib/offer-engine";
import styles from "./coupon-field.module.css";

const serviceCodes: Record<PawspaceService, "grooming" | "dog_training" | "boarding" | "pet_sitting"> = {
  Grooming: "grooming",
  "Dog Training": "dog_training",
  Boarding: "boarding",
  "Pet Sitting": "pet_sitting",
};

type AvailableOffer = { code: string; name: string; description: string; autoApply: boolean };

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
  cartKey?: string;
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
    cartKey = "",
    onDiscountChange,
  } = props;
  const [code, setCode] = useState("");
  const [applied, setApplied] = useState("");
  const [message, setMessage] = useState("");
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [offers, setOffers] = useState<AvailableOffer[]>([]);
  const [showOffers, setShowOffers] = useState(false);
  const autoApplied = useRef(false);
  const appliedCommercialKey = useRef("");
  const commercialKey = JSON.stringify([service,orderValue,paymentMode,isSubscription,cityId,packageCode,customerId,channel,eligible,cartKey]);
  const [previousCommercialKey, setPreviousCommercialKey] = useState(commercialKey);
  if (previousCommercialKey !== commercialKey) {
    setPreviousCommercialKey(commercialKey);
    setLoadingKey(null);
  }
  const loading = loadingKey === commercialKey;
  const requestVersion=useRef(0);
  useEffect(()=>{requestVersion.current+=1;return()=>{requestVersion.current+=1;};},[commercialKey]);

  const apply = async (rawCode?: string, options?: { keepGuardArmed?: boolean }) => {
    const normalized = (rawCode ?? code).trim().toUpperCase();
    if (!normalized || loading) return;
    if (!customerId) { setMessage("Sign in required before applying a coupon"); return; }
    const version=++requestVersion.current;
    setApplied("");
    // A customer pressing Apply clears the caller's coupon state outright. An automatic re-quote must
    // not: blanking the code here is the CUST-L-D06 blindness itself, and would unblock Confirm at
    // full price for however long the fresh quote is still in flight.
    if (!options?.keepGuardArmed) onDiscountChange(0, "");
    setLoadingKey(commercialKey);
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
      if(version!==requestVersion.current)return;
      if (!result.valid || !result.code) {
        setApplied("");
        setMessage(result.error || "Coupon is not eligible for this booking");
        onDiscountChange(0, "");
        return;
      }
      setApplied(result.code);
      appliedCommercialKey.current = commercialKey;
      setMessage(`UAT coupon applied · you save ₹${result.discount}`);
      onDiscountChange(result.discount, result.code, result.quoteId);
    } catch (error) {
      if(version!==requestVersion.current)return;
      setApplied("");
      setMessage(error instanceof Error ? error.message : "Unable to validate coupon");
      onDiscountChange(0, "");
    } finally {
      if(version===requestVersion.current)setLoadingKey(null);
    }
  };

  // Founder ask: available codes pop up here, and a NEW customer's welcome coupon auto-populates
  // and applies without typing. Listing comes from the governed /api/customer-offers browse
  // surface; the discount itself is still only ever decided by the server quote above.
  useEffect(() => {
    if (!customerId || !eligible) return;
    let active = true;
    void fetch(`/api/customer-offers?customerId=${encodeURIComponent(customerId)}`, { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json()) as { data?: { coupons: AvailableOffer[]; autoApply: AvailableOffer | null } };
        if (!active || !body.data) return;
        setOffers(body.data.coupons);
        if (body.data.autoApply && !autoApplied.current && !applied && !code) {
          autoApplied.current = true;
          setCode(body.data.autoApply.code);
          void apply(body.data.autoApply.code);
        }
      })
      .catch(() => {});
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId, eligible]);

  useEffect(() => {
    if (!applied || !appliedCommercialKey.current || appliedCommercialKey.current === commercialKey) return;
    // CUST-L-D06: report the DROPPED code, not "". Passing "" here reads identically to "no coupon was
    // ever involved", which let a caller's own stale-quote guard (couponCode && !couponQuoteId) go
    // silent and a booking confirm at full price with no block and only a small, easy-to-miss line.
    // Keeping the code lets every caller's existing guard catch "a coupon needs reapplying" on its own.
    const report = droppedCouponReport(applied);
    setApplied("");
    setMessage("Booking details changed — rechecking this coupon against the new total…");
    onDiscountChange(report.discount, report.code);
    // V2 launch e2e: switching the payment mode is an ordinary customer action, and a new customer's
    // welcome coupon auto-applies above without them ever typing it. Reporting the drop alone left
    // Confirm disabled at the last step of the funnel, asking them to "reapply" a code they never
    // chose. Fetch the fresh governed quote for them. The server still decides the discount for the
    // NEW terms, and until it answers the caller's guard stays armed above, so Confirm cannot fire
    // against the stale one. If the coupon no longer qualifies, apply() clears it and says why.
    void apply(report.code, { keepGuardArmed: true });
  }, [applied, commercialKey, onDiscountChange]);

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
          onChange={(event) => {
            setCode(event.target.value);
            setApplied("");
            setMessage("");
            onDiscountChange(0, "");
          }}
          placeholder={eligible ? "UATCARE100" : "Choose 100% payment to apply"}
          aria-label="Coupon code"
        />
        <button type="button" disabled={!eligible || !code.trim() || loading} onClick={() => void apply()}>
          {loading ? "Checking…" : "Apply"}
        </button>
      </label>
      {offers.length > 0 && eligible && (
        <div className={styles.offersRow}>
          <button type="button" className={styles.offersToggle} onClick={() => setShowOffers(value => !value)}>
            {showOffers ? "Hide available codes" : `View ${offers.length} available code${offers.length === 1 ? "" : "s"} ›`}
          </button>
          {showOffers && (
            <div className={styles.offersList} role="list">
              {offers.map(offer => (
                <button type="button" key={offer.code} role="listitem" className={applied === offer.code ? styles.offerApplied : ""} onClick={() => { setCode(offer.code); void apply(offer.code); setShowOffers(false); }}>
                  <b>{offer.code}</b>
                  <span>{offer.description}</span>
                  {offer.autoApply && <em>For you</em>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {message && <small className={applied ? styles.success : styles.error}>{message}</small>}
    </section>
  );
}
