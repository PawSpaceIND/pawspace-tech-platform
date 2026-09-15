/**
 * The ONE description of how staff recover a provider, for every service line.
 *
 * Why this file exists. `/api/uat-scheduling` set `canRecover` only when `service_code==="grooming"`,
 * so the day board's "Recover provider" control — the only staff control that carries the "Provider
 * did not arrive" option — rendered on grooming rows and nowhere else. Every other service line had
 * a staff-capable recovery API already (`POST /api/boarding-stays` `host_unavailable`/`no_show`
 * requires `bookings.manage` and opens a `boarding_recovery_cases` row; sitting, walking and taxi
 * carry the identical shape), but the ONLY UI caller of those routes was the provider's own app. A
 * runtime audit followed the platform's own HIGH alert — "boarding acceptance timeout … Reassign or
 * contact the host" — and found no reachable control at the end of any path.
 *
 * The mapping lives here rather than inside the day board so the SERVER predicate that decides
 * `canRecover` and the CLIENT that builds the request are the same statement of fact, and so both can
 * be executed by a test without a browser.
 *
 * Grooming is deliberately NOT folded into the lifecycle shape: `/api/provider-assignment-recovery`
 * re-runs the matcher and selects a replacement itself, which none of the lifecycle routes do. Its
 * entry below records that difference instead of hiding it.
 */

export type RecoveryBodyShape = "assignment_recovery" | "lifecycle";

export type ServiceRecoveryPlan = {
  /** canonical_bookings.service_code */
  serviceCode: string;
  /** API path the staff control posts to. */
  endpoint: string;
  /** Which identifier that endpoint keys on. Boarding keys on the stay, everything else on the booking. */
  subjectField: "bookingId" | "stayId";
  bodyShape: RecoveryBodyShape;
  /** Action for "this provider cannot take the job" (offer expired, unreachable, withdrew). */
  unavailableAction: string;
  /** Action for "the provider did not arrive". */
  noShowAction: "no_show";
  /** Where the replacement is actually chosen once a recovery case is open. */
  queuePath: string;
  /** What this service calls its provider, in operator language. */
  providerNoun: string;
  /** Canonical booking statuses a recovery may still be opened from. */
  recoverableBookingStatuses: string[];
  /** True when this endpoint picks the replacement itself rather than opening a case for Operations. */
  selectsReplacement: boolean;
  /** True when /api/provider-assignment-recovery's retry_notifications action covers this service. */
  supportsNotificationRetry: boolean;
};

/**
 * A booking whose provider assignment is already being recovered. Offering "open recovery" again on
 * these would 409 at the lifecycle guard, so the control links to the queue instead.
 */
export const RECOVERY_IN_FLIGHT_BOOKING_STATUSES = ["reassignment_needed", "reassignment_offered"];

const PLANS: ServiceRecoveryPlan[] = [
  {
    serviceCode: "grooming",
    endpoint: "/api/provider-assignment-recovery",
    subjectField: "bookingId",
    bodyShape: "assignment_recovery",
    unavailableAction: "unavailable",
    noShowAction: "no_show",
    queuePath: "/team/scheduling",
    providerNoun: "groomer",
    recoverableBookingStatuses: ["confirmed", "assigned", "on_the_way", "arrived"],
    selectsReplacement: true,
    supportsNotificationRetry: true,
  },
  {
    serviceCode: "boarding",
    endpoint: "/api/boarding-stays",
    subjectField: "stayId",
    bodyShape: "lifecycle",
    unavailableAction: "host_unavailable",
    noShowAction: "no_show",
    queuePath: "/team/operations/boarding",
    providerNoun: "host",
    recoverableBookingStatuses: ["confirmed", "assigned", "awaiting_acceptance", "awaiting_host_acceptance", "on_the_way", "arrived", "in_progress"],
    selectsReplacement: false,
    supportsNotificationRetry: false,
  },
  {
    serviceCode: "pet_sitting",
    endpoint: "/api/sitting-lifecycle",
    subjectField: "bookingId",
    bodyShape: "lifecycle",
    unavailableAction: "sitter_unavailable",
    noShowAction: "no_show",
    queuePath: "/team/operations/sitting",
    providerNoun: "sitter",
    recoverableBookingStatuses: ["confirmed", "assigned", "awaiting_acceptance", "on_the_way", "arrived", "in_progress"],
    selectsReplacement: false,
    supportsNotificationRetry: false,
  },
  {
    serviceCode: "dog_walking",
    endpoint: "/api/walking-lifecycle",
    subjectField: "bookingId",
    bodyShape: "lifecycle",
    unavailableAction: "walker_unavailable",
    noShowAction: "no_show",
    queuePath: "/team/operations/walking",
    providerNoun: "walker",
    recoverableBookingStatuses: ["confirmed", "assigned", "awaiting_acceptance", "on_the_way", "arrived", "in_progress"],
    selectsReplacement: false,
    supportsNotificationRetry: false,
  },
  {
    serviceCode: "pet_taxi",
    endpoint: "/api/taxi-lifecycle",
    subjectField: "bookingId",
    bodyShape: "lifecycle",
    unavailableAction: "driver_unavailable",
    noShowAction: "no_show",
    queuePath: "/team/operations/taxi",
    providerNoun: "driver",
    recoverableBookingStatuses: ["confirmed", "assigned", "awaiting_acceptance", "on_the_way", "arrived", "in_progress"],
    selectsReplacement: false,
    supportsNotificationRetry: false,
  },
];

const BY_CODE = new Map(PLANS.map((plan) => [plan.serviceCode, plan]));

export function serviceRecoveryPlan(serviceCode: unknown): ServiceRecoveryPlan | null {
  return BY_CODE.get(String(serviceCode ?? "")) ?? null;
}

export function recoverableServiceCodes(): string[] {
  return PLANS.map((plan) => plan.serviceCode);
}

export type StaffRecoveryContext = {
  serviceCode: unknown;
  bookingId: unknown;
  bookingStatus: unknown;
  /** The provider the operator is looking at, and the provider the booking actually holds. */
  columnProviderId: unknown;
  bookingProviderId: unknown;
  reservationStatus?: unknown;
  canManageBookings: boolean;
};

/**
 * Can a `bookings.manage` operator open a recovery on this row right now?
 *
 * Used by `/api/uat-scheduling` to set `canRecover` and by the day board to decide what to render, so
 * the screen can never offer a control the server would refuse, or hide one it would accept.
 */
export function canStaffRecover(context: StaffRecoveryContext): boolean {
  if (!context.canManageBookings) return false;
  if (!String(context.bookingId ?? "").trim()) return false;
  const plan = serviceRecoveryPlan(context.serviceCode);
  if (!plan) return false;
  if (String(context.reservationStatus ?? "") === "cancelled") return false;
  if (String(context.bookingProviderId ?? "") !== String(context.columnProviderId ?? "")) return false;
  return plan.recoverableBookingStatuses.includes(String(context.bookingStatus ?? ""));
}

/** True when a recovery is already open for this booking, so the operator belongs in the queue. */
export function recoveryInFlight(bookingStatus: unknown): boolean {
  return RECOVERY_IN_FLIGHT_BOOKING_STATUSES.includes(String(bookingStatus ?? ""));
}

export type RecoveryRequestInput = {
  serviceCode: unknown;
  /** The booking id, or for boarding the stay id. */
  subjectId: string;
  providerId?: string;
  problem: "unavailable" | "no_show";
  reason: string;
  idempotencyKey?: string;
};

/**
 * The exact request a staff recovery control must send. Returning the URL and body — rather than
 * performing the fetch — is what lets a test drive the REAL route handler with it and read the
 * database back, instead of asserting that a button exists.
 */
export function buildRecoveryRequest(input: RecoveryRequestInput): { url: string; body: Record<string, unknown> } {
  const plan = serviceRecoveryPlan(input.serviceCode);
  if (!plan) throw new Error(`No staff recovery path is defined for service ${String(input.serviceCode)}`);
  const subjectId = String(input.subjectId ?? "").trim();
  if (!subjectId) throw new Error(`A ${plan.subjectField} is required to recover a ${plan.providerNoun}`);
  const reason = String(input.reason ?? "").trim();
  if (reason.length < 8) throw new Error("A recovery reason of at least 8 characters is required");
  const action = input.problem === "no_show" ? plan.noShowAction : plan.unavailableAction;
  if (plan.bodyShape === "assignment_recovery") {
    const providerId = String(input.providerId ?? "").trim();
    if (!providerId) throw new Error("The current provider is required to recover a grooming assignment");
    return { url: plan.endpoint, body: { bookingId: subjectId, providerId, action, reason } };
  }
  return {
    url: plan.endpoint,
    body: {
      [plan.subjectField]: subjectId,
      action,
      reason,
      idempotencyKey: String(input.idempotencyKey ?? "").trim() || `staff-recovery:${plan.serviceCode}:${subjectId}:${action}:${Date.now()}`,
    },
  };
}

/**
 * A boarding stay whose host can still be released by Operations.
 *
 * Operations could previously only pick a REPLACEMENT, and only once a recovery case already
 * existed — and the only thing in the platform that opened one was the host's own app. So the
 * platform's own HIGH "host has not accepted ... Reassign or contact the host" alert had no control
 * behind it anywhere. Exported here rather than kept inside the page so it can be executed.
 */
export const RECOVERABLE_BOARDING_STAY_STATUSES = ["awaiting_host_acceptance", "confirmed", "in_progress"];
export function boardingHostReleasable(stay?: { status?: unknown; exceptionFlags?: unknown } | null): boolean {
  if (!stay) return false;
  const flags = Array.isArray(stay.exceptionFlags) ? stay.exceptionFlags.map(String) : [];
  return RECOVERABLE_BOARDING_STAY_STATUSES.includes(String(stay.status ?? "")) && !flags.includes("host_recovery");
}

/** The sentence an operator reads after a recovery opens, naming the queue they must go to next. */
export function recoveryOutcomeMessage(plan: ServiceRecoveryPlan, subjectId: string, status: string): string {
  if (plan.selectsReplacement) return `${subjectId}: recovery recorded (${status.replaceAll("_", " ")}).`;
  return `${subjectId}: the ${plan.providerNoun} assignment is now in recovery (${status.replaceAll("_", " ")}). Choose the replacement in the exception queue at ${plan.queuePath}.`;
}
