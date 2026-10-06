/**
 * How the customer Training screens describe trainer assignment (workbook rows 16-36, automatic matching only).
 *
 * FROZEN backend contract. Customer programme GET/POST carry a top-level
 *   data.assignment?: { mode: 'contractor_broadcast' | 'full_time' | 'assigned';
 *                       state: 'pending' | 'needs_operations' | 'assigned';
 *                       providerId: string | null; offerExpiresAt: number | null }
 * providerId is null while pending or needs_operations; offerExpiresAt (epoch ms) is set only for a pending
 * recipient offer. prepareTrainingProgramme keeps the assessment null; materialise/load expose the execution
 * assignment. A full-time trainer is assigned at once, with no acceptance step; a contractor broadcast reads
 * "Finding your certified trainer" until the first valid award, then the winner. The screens NEVER show the
 * broadcast's internal owner or the scheduler's provisional provider; the winner's name is resolved from the
 * public provider profile by providerId (app/training/assigned-trainer.tsx). Browser-safe.
 */
export const FINDING_TRAINER = "Finding your certified trainer";
export const ASSIGNED_TRAINER = "Your certified trainer";

export type ProgrammeAssignment = {
  mode: "contractor_broadcast" | "full_time" | "assigned" | string;
  state: "pending" | "needs_operations" | "assigned" | string;
  providerId: string | null;
  offerExpiresAt: number | null;
};

export type TrainerAssignmentView = {
  state: "pending" | "needs_operations" | "assigned" | "unknown";
  /** The words the screen shows where a trainer name would go, until a public name is resolved. */
  label: string;
  /** One sentence under it. */
  detail: string;
  providerId: string | null;
};

/** The top-level assignment of a programme payload, read structurally; null when absent (assessment or pre-award). */
export function programmeAssignment(programme: unknown): ProgrammeAssignment | null {
  if (!programme || typeof programme !== "object") return null;
  const assignment = (programme as { assignment?: unknown }).assignment;
  if (!assignment || typeof assignment !== "object") return null;
  const value = assignment as Record<string, unknown>;
  return {
    mode: String(value.mode ?? ""),
    state: String(value.state ?? ""),
    providerId: typeof value.providerId === "string" && value.providerId.trim() ? value.providerId : null,
    offerExpiresAt: typeof value.offerExpiresAt === "number" && Number.isFinite(value.offerExpiresAt) ? value.offerExpiresAt : null,
  };
}

function istClock(ms: number): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(ms);
}

export function trainerAssignmentView(input: { assignment?: ProgrammeAssignment | null }): TrainerAssignmentView {
  const assignment = input.assignment ?? null;
  if (!assignment) return { state: "unknown", label: FINDING_TRAINER, detail: "PawSpace matches your trainer automatically after you reserve. The name appears here once the award is made.", providerId: null };
  const fullTime = assignment.mode === "full_time";
  if (assignment.state === "assigned" && assignment.providerId) {
    return { state: "assigned", label: ASSIGNED_TRAINER, detail: fullTime ? "A PawSpace full-time trainer is assigned to your programme." : "A certified trainer accepted your programme and is assigned.", providerId: assignment.providerId };
  }
  if (assignment.state === "needs_operations") {
    return { state: "needs_operations", label: FINDING_TRAINER, detail: "No trainer could be awarded automatically. PawSpace Operations is arranging your trainer; nothing more is charged until one is confirmed.", providerId: null };
  }
  const by = assignment.offerExpiresAt != null ? istClock(assignment.offerExpiresAt) : null;
  return {
    state: "pending",
    label: FINDING_TRAINER,
    detail: `${fullTime ? "A PawSpace full-time trainer is being assigned." : "Your programme is offered to certified trainers; the first valid acceptance becomes your trainer."}${by ? ` Answer expected by ${by} IST.` : ""} The name appears here once the award is made.`,
    providerId: null,
  };
}

/** The one explanation both customer surfaces show instead of a trainer list. */
export const AUTO_MATCH_COPY = "PawSpace matches your trainer automatically after you reserve: an eligible full-time trainer is assigned straight away, with no acceptance step; otherwise the programme is offered to certified contractors and the first valid acceptance becomes your trainer. Until then your booking reads 'Finding your certified trainer'. You do not choose a trainer and none is pre-selected.";
