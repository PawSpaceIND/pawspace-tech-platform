import {
  calculateQueuePriority,
  type QueuePriorityInput,
  type QueuePriorityResult,
} from "@/lib/types/sales-work-queue";

export interface RankedWorkQueueCandidate<T> {
  candidate: T;
  priorityInput: QueuePriorityInput;
}

export interface RankedWorkQueueItem<T> extends RankedWorkQueueCandidate<T> {
  priority: QueuePriorityResult;
}

export function rankUnifiedWorkQueue<T>(
  candidates: RankedWorkQueueCandidate<T>[],
): RankedWorkQueueItem<T>[] {
  return candidates
    .map((entry) => ({
      ...entry,
      priority: calculateQueuePriority(entry.priorityInput),
    }))
    .sort((left, right) => right.priority.score - left.priority.score);
}

export {
  UnifiedWorkQueue,
  type UnifiedWorkQueueCandidate,
} from "@/app/components/sales/UnifiedWorkQueue";
