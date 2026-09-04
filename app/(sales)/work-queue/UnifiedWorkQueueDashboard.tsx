import {
  Badge,
  StatCard,
  TeamSection,
  TeamShell,
  TeamStatGrid,
  TeamTable,
} from "../../components/ui";
import {
  calculateQueuePriority,
  type UnifiedWorkItem,
  type UnifiedWorkItemType,
} from "../../../lib/types/sales-work-queue";

export interface UnifiedWorkQueueDashboardProps {
  items: readonly UnifiedWorkItem[];
}

interface ScoredWorkItem {
  item: UnifiedWorkItem;
  priority: number;
}

const QUEUE_VIEWS: ReadonlyArray<{
  title: string;
  note: string;
  types: readonly UnifiedWorkItemType[];
}> = [
  { title: "New Leads", note: "First-response work ordered by commercial urgency.", types: ["new_lead"] },
  { title: "Win-Backs", note: "Retention opportunities ready for governed follow-up.", types: ["win_back"] },
  { title: "Renewals", note: "Subscription renewal and dunning work requiring action.", types: ["renewal"] },
  { title: "SLAs", note: "SLA and RNR follow-up work, preserving canonical CRM ownership.", types: ["sla", "rnr"] },
  { title: "Cross-Sells", note: "Eligible cross-sell opportunities ranked by expected value and fit.", types: ["cross_sell"] },
];

const formatDueAt = (dueAt: number | null | undefined) => {
  if (!dueAt) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(dueAt));
};

const statusLabel = (status: UnifiedWorkItem["status"]) => status.replaceAll("_", " ");

const priorityTone = (priority: number): "danger" | "warning" | "info" | "neutral" => {
  if (priority >= 80) return "danger";
  if (priority >= 60) return "warning";
  if (priority >= 40) return "info";
  return "neutral";
};

function scoreWorkItem(item: UnifiedWorkItem): ScoredWorkItem {
  return {
    item,
    priority: calculateQueuePriority(
      item.urgency,
      item.conversionProbability,
      item.contributionOpportunity,
      item.customerValue,
      item.capacity,
    ),
  };
}

export default function UnifiedWorkQueueDashboard({
  items,
}: UnifiedWorkQueueDashboardProps) {
  const scoredItems = items
    .map(scoreWorkItem)
    .sort((left, right) =>
      right.priority - left.priority ||
      (left.item.dueAt ?? Number.POSITIVE_INFINITY) -
        (right.item.dueAt ?? Number.POSITIVE_INFINITY) ||
      left.item.workItemId.localeCompare(right.item.workItemId),
    );

  const activeItems = scoredItems.filter(({ item }) => item.status !== "completed");
  const highPriority = activeItems.filter(({ priority }) => priority >= 80).length;
  const suppressed = activeItems.filter(({ item }) => item.status === "suppressed").length;
  const scheduled = activeItems.filter(({ item }) => item.dueAt != null).length;

  return (
    <TeamShell
      eyebrow="PAWSPACE V2 · SALES & RETENTION"
      title="Unified Work Queue"
      description="One explainable queue for new business and retention work. Priority is deterministic on a 0–100 scale; suppression and governed eligibility remain authoritative over score."
    >
      <TeamStatGrid>
        <StatCard label="Active work" value={activeItems.length} meta="all open queue types" />
        <StatCard label="Priority 80+" value={highPriority} meta="highest-action tier" />
        <StatCard label="Scheduled" value={scheduled} meta="work with a due time" />
        <StatCard label="Suppressed" value={suppressed} meta="visible but not contactable" />
      </TeamStatGrid>

      {QUEUE_VIEWS.map((view) => {
        const rows = activeItems.filter(({ item }) => view.types.includes(item.type));

        return (
          <TeamSection
            key={view.title}
            title={`${view.title} · ${rows.length}`}
            note={view.note}
          >
            <TeamTable
              head={["Priority", "Work", "Service", "Reason", "Due", "Status"]}
              rows={rows.map(({ item, priority }) => [
                <Badge key={`${item.workItemId}-priority`} tone={priorityTone(priority)}>
                  {priority.toFixed(2)}
                </Badge>,
                item.title,
                item.serviceCode || "—",
                item.reason,
                formatDueAt(item.dueAt),
                <Badge key={`${item.workItemId}-status`} tone={item.status === "suppressed" ? "danger" : "neutral"}>
                  {statusLabel(item.status)}
                </Badge>,
              ])}
              empty={`No active ${view.title.toLowerCase()} work.`}
            />
          </TeamSection>
        );
      })}
    </TeamShell>
  );
}
