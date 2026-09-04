import Link from "next/link";
import type { ContactSafetyDecision } from "@/lib/services/contact-safety-gate";
import type { PetNextBestServiceRecommendation } from "@/lib/services/pet-next-best-service";
import styles from "./cross-sell-command-center.module.css";

interface NextBestServiceCardProps {
  recommendation: PetNextBestServiceRecommendation;
  householdName: string;
  petName: string;
  safety: ContactSafetyDecision;
}

const SAFETY_REASON_LABELS: Record<string, string> = {
  marketing_opt_out: "Marketing opt-out",
  channel_opt_out: "Channel opt-out",
  open_complaint: "Open complaint or safety case",
  unresolved_refund_or_payment_dispute: "Unresolved refund or payment dispute",
  quiet_hours: "Quiet hours",
  identity_review_required: "Identity review required",
  data_quality_review_required: "Data-quality review required",
  opportunity_closed: "Opportunity closed",
};

function pretty(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatMoney(value: number): string {
  if (value <= 0) return "Not configured";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value);
}

export function NextBestServiceCard({ recommendation, householdName, petName, safety }: NextBestServiceCardProps) {
  const suppressed = safety.eligibility === "Suppressed";
  const contactBlocked = safety.eligibility !== "Allowed";
  const safetyReason = safety.reasonCodes.map((reason) => SAFETY_REASON_LABELS[reason] ?? pretty(reason)).join(" · ");

  return (
    <article className={`${styles.recommendationCard} ${suppressed ? styles.recommendationDisabled : ""}`} aria-disabled={contactBlocked}>
      <header><div><span>NEXT BEST SERVICE</span><h3>{pretty(recommendation.targetService)}</h3></div><em>{Math.round(recommendation.confidence * 100)}% confidence</em></header>
      <div className={styles.householdLine}><strong>{householdName}</strong><span>{petName}</span></div>
      <dl className={styles.recommendationFacts}>
        <div><dt>Reason</dt><dd>{recommendation.explanation}</dd></div>
        <div><dt>Estimated Revenue</dt><dd>{formatMoney(recommendation.expectedRevenue)}</dd></div>
      </dl>
      <div className={styles.reasonChips}>{recommendation.reasonCodes.map((reason) => <span key={reason}>{pretty(reason)}</span>)}</div>
      {contactBlocked ? <div className={styles.suppressionBanner} role="status"><strong>{safety.eligibility}</strong><span>{safetyReason || "Contact requires safety review before outreach."}</span></div> : <Link className={styles.primaryAction} href="/team/sales">Open governed outreach</Link>}
    </article>
  );
}
