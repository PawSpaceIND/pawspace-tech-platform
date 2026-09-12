"use client";
// Standalone, self-contained customer offers card - deliberately does not import from or depend
// on any of the booking-flow checkout files. Renders /api/customer-offers data (real coupon
// campaigns from lib/coupon-governance.ts, browsed via lib/customer-offers.ts). Tapping a chip
// copies the code and calls the optional onSelectCode callback so the checkout stream can wire it
// into its own CouponField - this component never applies a discount itself.
import { useEffect, useState } from "react";
import styles from "./offers-card.module.css";

type CustomerOffer = {
  code: string;
  name: string;
  discountType: "fixed" | "percent";
  discountValue: number;
  maxDiscount: number | null;
  minOrder: number;
  description: string;
  autoApply: boolean;
};

type OffersResponse = { coupons: CustomerOffer[]; autoApply: CustomerOffer | null };

export default function OffersCard({ customerId, onSelectCode }: { customerId: string; onSelectCode?: (code: string) => void }) {
  const [offers, setOffers] = useState<OffersResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [copiedCode, setCopiedCode] = useState("");

  useEffect(() => {
    let active = true;
    void fetch(`/api/customer-offers?customerId=${encodeURIComponent(customerId)}`)
      .then(async (response) => {
        const body = (await response.json()) as { data?: OffersResponse; error?: string };
        if (!response.ok) throw new Error(body.error || "Unable to load offers");
        if (active) setOffers(body.data ?? { coupons: [], autoApply: null });
      })
      .catch((problem) => {
        if (active) setError(problem instanceof Error ? problem.message : "Unable to load offers");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [customerId]);

  const selectCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // clipboard may be unavailable (e.g. non-secure context) - selection still proceeds
    }
    setCopiedCode(code);
    setTimeout(() => setCopiedCode(""), 1800);
    onSelectCode?.(code);
  };



  if (loading) {
    return (
      <section className={styles.cardShell}>
        <p className={styles.loadingText}>Loading offers…</p>
      </section>
    );
  }

  if (error || !offers) {
    return (
      <section className={styles.cardShell}>
        <p className={styles.errorText}>{error || "Offers unavailable."}</p>
      </section>
    );
  }

  const otherCoupons = offers.coupons.filter((offer) => offer.code !== offers.autoApply?.code);

  return (
    <section className={styles.cardShell}>
      <div className={styles.sectionTitle}>Offers for you</div>

      {offers.autoApply && (
        <div className={styles.autoApply}>
          <div className={styles.autoApplyTitle}>🎉 Welcome offer applied</div>
          <p className={styles.offerDescription}>
            <b>{offers.autoApply.code}</b> · {offers.autoApply.description}
          </p>
        </div>
      )}

      {otherCoupons.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Available codes</div>
          <div className={styles.couponList}>
            {otherCoupons.map((offer) => (
              <button
                key={offer.code}
                type="button"
                onClick={() => selectCode(offer.code)}
                className={styles.couponButton}
              >
                <span>
                  <b className={styles.code}>{offer.code}</b> <span className={styles.description}>· {offer.description}</span>
                </span>
                <span className={styles.copyState}>{copiedCode === offer.code ? "Copied ✓" : "Tap to use"}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {offers.coupons.length === 0 && <p className={styles.empty}>No offers available right now.</p>}
    </section>
  );
}
