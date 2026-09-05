import {
  calculateQueuePriority,
  type QueuePriorityInput,
  type UnifiedWorkItem,
} from "@/lib/types/sales-work-queue";
import styles from "./cross-sell-command-center.module.css";

export interface UnifiedWorkQueueCandidate {
  item: UnifiedWorkItem;
  priorityInput: QueuePriorityInput;
  householdName: string;
  petNames: string[];
  reason: string;
}

interface UnifiedWorkQueueProps {
  candidates: UnifiedWorkQueueCandidate[];
}

function pretty(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatMoney(value: number | null | undefined): string {
  if (value == null) return "Not configured";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value);
}

export function UnifiedWorkQueue({ candidates }: UnifiedWorkQueueProps) {
  const ranked = candidates
    .map((candidate) => ({ ...candidate, priority: calculateQueuePriority(candidate.priorityInput) }))
    .sort((left, right) => right.priority.score - left.priority.score || left.item.id.localeCompare(right.item.id));

  return (
    <section className={styles.queuePanel} aria-labelledby="unified-work-queue-title">
      <header className={styles.sectionHeader}>
        <div><span>UNIFIED WORK QUEUE</span><h2 id="unified-work-queue-title">Highest-value customer work first</h2></div>
        <small>{ranked.length} active household{ranked.length === 1 ? "" : "s"}</small>
      </header>
      <div className={styles.queueHead} aria-hidden="true"><span>Priority</span><span>Household</span><span>Work type</span><span>Opportunity</span><span>Safety</span></div>
      <div className={styles.queueRows}>
        {ranked.map(({ item, householdName, petNames, reason, priority }) => (
          <article className={styles.queueRow} key={item.id}>
            <div className={styles.priorityCell}><strong>{priority.score}</strong><span>of 100</span></div>
            <div><strong>{householdName}</strong><span>{petNames.length ? petNames.join(", ") : "No canonical pet"}</span></div>
            <div><span className={styles.workType}>{pretty(item.workType)}</span><small>{item.ownerId || "Unassigned"}</small></div>
            <div><strong>{formatMoney(item.expectedRevenue)}</strong><span>{reason}</span></div>
            <div>
              <span className={item.contactEligibility === "Allowed" ? styles.safetyAllowed : item.contactEligibility === "Suppressed" ? styles.safetySuppressed : styles.safetyReview}>{item.contactEligibility}</span>
              <small>{priority.blocked ? "Blocked · " : ""}{[...priority.reasons, ...item.sourceReasonCodes].slice(0, 2).map(pretty).join(" · ")}</small>
            </div>
          </article>
        ))}
      </div>
      {ranked.length === 0 && <div className={styles.emptyState}><strong>No New Lead, Win-Back, or Cross-Sell work is active.</strong><span>The queue will populate from canonical Customer 360 and governed revenue signals.</span></div>}
    </section>
  );
}
