"use client";
// Standalone, self-contained customer offers card - deliberately does not import from or depend
// on any of the booking-flow checkout files. Renders /api/customer-offers data (real coupon
// campaigns from lib/coupon-governance.ts, browsed via lib/customer-offers.ts). Tapping a chip
// copies the code and calls the optional onSelectCode callback so the checkout stream can wire it
// into its own CouponField - this component never applies a discount itself.
import { useEffect, useState } from "react";

const EMERALD = "#01261F";
const GOLD = "#E6B34E";
const IVORY = "#F6F2E9";

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

  const cardShell: React.CSSProperties = {
    background: EMERALD,
    color: IVORY,
    borderRadius: 20,
    padding: 20,
    fontFamily: "system-ui, -apple-system, sans-serif",
    maxWidth: 420,
    boxShadow: "0 12px 28px rgba(1,38,31,0.35)",
  };

  if (loading) {
    return (
      <section style={cardShell}>
        <p style={{ margin: 0, opacity: 0.8 }}>Loading offers…</p>
      </section>
    );
  }

  if (error || !offers) {
    return (
      <section style={cardShell}>
        <p style={{ margin: 0, opacity: 0.85 }}>{error || "Offers unavailable."}</p>
      </section>
    );
  }

  const otherCoupons = offers.coupons.filter((offer) => offer.code !== offers.autoApply?.code);

  return (
    <section style={cardShell}>
      <div style={{ fontSize: 12, fontWeight: 700, opacity: 0.7, letterSpacing: 0.4, textTransform: "uppercase" }}>Offers for you</div>

      {offers.autoApply && (
        <div
          style={{
            marginTop: 12,
            padding: 14,
            borderRadius: 14,
            background: `linear-gradient(135deg, rgba(230,179,78,0.22), rgba(230,179,78,0.08))`,
            border: `1px solid ${GOLD}`,
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 700, color: GOLD }}>🎉 Welcome offer applied</div>
          <p style={{ fontSize: 13, lineHeight: 1.45, margin: "6px 0 0", opacity: 0.92 }}>
            <b>{offers.autoApply.code}</b> · {offers.autoApply.description}
          </p>
        </div>
      )}

      {otherCoupons.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, opacity: 0.7, letterSpacing: 0.4, textTransform: "uppercase" }}>Available codes</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
            {otherCoupons.map((offer) => (
              <button
                key={offer.code}
                type="button"
                onClick={() => selectCode(offer.code)}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 14px",
                  borderRadius: 999,
                  background: "rgba(255,255,255,0.08)",
                  border: "1px solid rgba(255,255,255,0.16)",
                  color: IVORY,
                  cursor: "pointer",
                  textAlign: "left",
                  font: "inherit",
                }}
              >
                <span>
                  <b style={{ color: GOLD }}>{offer.code}</b> <span style={{ opacity: 0.85, fontSize: 13 }}>· {offer.description}</span>
                </span>
                <span style={{ fontSize: 12, opacity: 0.75, flexShrink: 0 }}>{copiedCode === offer.code ? "Copied ✓" : "Tap to use"}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {offers.coupons.length === 0 && <p style={{ fontSize: 13, opacity: 0.75, marginTop: 12 }}>No offers available right now.</p>}
    </section>
  );
}
