/**
 * First-appointment (rolling) checkout for Training, as the customer screens apply the FROZEN backend contract:
 *
 *   - quoteTraining / POST /api/training-commercial accepts schedulingMode:'rolling_v1'; the quote keeps the full
 *     purchased entitlement (sessions, validity, minutes per session).
 *   - trainingReservationForChoice(selection,{mode:'auto'}) over the FULL selection
 *     {customerId,petIds,cityId,zoneId,scheduledStart,quote,schedulingMode} (lib/training-availability-client.ts,
 *     backend-owned) generates ONE occurrence plus trainingQuoteId and trainingSchedulingMode and omits
 *     preferredProviderId. The screens consume that helper and never stamp or reconstruct sessions.
 *   - Later appointments go through the rolling-schedule API as the customer.
 *
 * The two types below only widen the base's parameter types with `schedulingMode` so the screens compile on a
 * base that predates the frozen helper signature; on the frozen branch they are redundant and harmless.
 */
import type { quoteTraining } from "./training-commercial-client";
import type { TrainingScheduleSelection } from "./training-availability-client";

export const TRAINING_SCHEDULING_MODE = "rolling_v1" as const;
export type RollingQuoteInput = Parameters<typeof quoteTraining>[0] & { schedulingMode: typeof TRAINING_SCHEDULING_MODE };
export type RollingSelection = TrainingScheduleSelection & { schedulingMode: typeof TRAINING_SCHEDULING_MODE };

/** What the customer bought, in one line: the whole entitlement, with only the first appointment reserved now. */
export function trainingEntitlementSummary(quote: { sessions: number; minutesPerSession: number; validityDays: number }) {
  return `${quote.sessions} ${quote.sessions === 1 ? "session" : "sessions"} · ${quote.minutesPerSession} min each · valid for ${quote.validityDays} days`;
}

export const ROLLING_CHECKOUT_COPY = "Only your first appointment is reserved when you pay. Your programme keeps every purchased session; you book each later appointment one at a time with your assigned trainer from your programme page, within the programme's validity.";
