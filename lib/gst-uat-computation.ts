/**
 * UAT PLACEHOLDER tax + provider-payout split computation.
 *
 * ⚠️ NON-PRODUCTION. This encodes a placeholder 18% GST and a placeholder 70/30 provider split so the
 * completion → invoice pipeline can be exercised on staging. It is NOT a production tax calculation:
 * the rate, the split, and the GSTIN used alongside it are dummy UAT values. Real GST rates (per SAC),
 * a real GSTIN, and finance approval must replace these before anything is treated as a tax invoice.
 *
 * The rules implemented (as specified for UAT):
 *   Invoice GST base:
 *     • In-house (full_time provider): 18% GST on the booking gross. Package prices are tax-INCLUSIVE
 *       (service_packages.tax_inclusive=1), so the 18% is EXTRACTED from the inclusive gross
 *       (gst = gross - gross/1.18) rather than added on top — this keeps the customer's total unchanged.
 *     • Marketplace (commission provider): 18% GST on the platform's commission only. The platform
 *       commission is the amount the platform retains after the provider payout (gross - providerPayout).
 *   Provider payout split (commission providers only; full_time providers are salaried → no per-job payout):
 *     • Grooming, Funeral: provider split is computed on the GROSS (e.g. 70% of ₹1000 = ₹700).
 *     • Boarding, Sitting, Training, Walking: deduct 18% of gross first, then split the remaining net
 *       (e.g. gross ₹1000 → net ₹820 → 70% = ₹574).
 *
 * ASSUMPTIONS / THINGS FOR FINANCE TO CONFIRM (flagged, not silently chosen):
 *   1. Invoice GST is extracted from the inclusive gross; the payout "deduct 18% GST" in rules 3/4 is
 *      applied as 18% OF gross (gross*0.82). These two 18%s are deliberately different conventions —
 *      one extracts from an inclusive price, the other is a flat deduction from the payout base — because
 *      the invoice tax and the payout base are separate computations in the spec.
 *   2. Marketplace GST base = actual retained commission (gross - providerPayout), so it stays consistent
 *      with the payout split for every vertical.
 *   3. Default provider share is 70% (30% commission). A per-provider override can be passed in.
 */

export const UAT_GST_RATE_PERCENT = 18;
export const UAT_DEFAULT_PROVIDER_SHARE_PERCENT = 70;

// Verticals whose provider split is taken on the gross vs. on the net-of-GST amount.
const GROSS_SPLIT_SERVICES = new Set<string>(["grooming", "funeral_memorial", "funeral"]);
const NET_SPLIT_SERVICES = new Set<string>(["boarding", "pet_sitting", "dog_training", "dog_walking"]);

export type EngagementModel = "full_time" | "commission";

export type UatTaxPayout = {
  gstRatePercent: number;
  engagementModel: EngagementModel;
  splitStyle: "gross" | "net_of_gst" | "n/a";
  gross: number;
  // Invoice side
  taxableBase: number; // fed to gst-accounting.issueInvoice as the line's taxableAmount (base * rate = gst)
  gstAmount: number;
  netAmount: number; // customer-facing invoice net; gross = netAmount + gstAmount always holds
  // Payout side
  providerSharePercent: number;
  payoutBase: number;
  providerPayout: number;
  platformCommission: number;
  payoutModel: "in_house_salaried" | "commission_gross_split" | "commission_net_split";
  placeholder: true;
};

const round2 = (n: number) => Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;

export function computeUatTaxAndPayout(input: {
  serviceCode: string;
  engagementModel: EngagementModel;
  gross: number;
  providerSharePercent?: number;
}): UatTaxPayout {
  const rate = UAT_GST_RATE_PERCENT;
  const gross = round2(Math.max(0, input.gross));
  const inHouse = input.engagementModel === "full_time";
  const sharePercent = Number.isFinite(input.providerSharePercent) ? Number(input.providerSharePercent) : UAT_DEFAULT_PROVIDER_SHARE_PERCENT;
  const grossSplit = GROSS_SPLIT_SERVICES.has(input.serviceCode) || (!NET_SPLIT_SERVICES.has(input.serviceCode));

  // --- Provider payout split (commission providers only) ---
  let payoutBase = 0, providerPayout = 0, payoutModel: UatTaxPayout["payoutModel"] = "in_house_salaried";
  let splitStyle: UatTaxPayout["splitStyle"] = "n/a";
  if (!inHouse) {
    if (grossSplit) {
      payoutBase = gross;
      splitStyle = "gross";
      payoutModel = "commission_gross_split";
    } else {
      payoutBase = round2(gross - gross * (rate / 100)); // deduct 18% of gross
      splitStyle = "net_of_gst";
      payoutModel = "commission_net_split";
    }
    providerPayout = round2(payoutBase * (sharePercent / 100));
  }
  const platformCommission = inHouse ? 0 : round2(gross - providerPayout);

  // --- Invoice GST ---
  let taxableBase: number, gstAmount: number;
  if (inHouse) {
    // 18% GST extracted from the tax-inclusive gross.
    taxableBase = round2(gross / (1 + rate / 100));
    gstAmount = round2(gross - taxableBase);
  } else {
    // 18% GST on the platform's retained commission.
    taxableBase = platformCommission;
    gstAmount = round2(platformCommission * (rate / 100));
  }
  const netAmount = round2(gross - gstAmount);

  return {
    gstRatePercent: rate,
    engagementModel: input.engagementModel,
    splitStyle,
    gross,
    taxableBase,
    gstAmount,
    netAmount,
    providerSharePercent: sharePercent,
    payoutBase,
    providerPayout,
    platformCommission,
    payoutModel,
    placeholder: true,
  };
}
