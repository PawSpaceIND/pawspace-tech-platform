import { loadCustomerConfirmationProjection, type CustomerConfirmationProjection } from "./customer-checkout-client";
import { loadTrainingProgramme, type CustomerTrainingProgramme } from "./training-programme-client";
import type { TrainingBookingResult } from "./training-booking-client";

const CONFIRMED_STATES = new Set(["confirmed", "assigned", "on_the_way", "arrived", "in_service", "completed"]);
const TERMINAL_FAILURES = new Set(["cancelled", "canceled", "refunded", "failed", "expired"]);
export class TrainingConfirmationPendingError extends Error {
  constructor() { super("Payment is verified, but the Training booking is still synchronizing. Refresh confirmation; do not pay again."); }
}
type Dependencies = {
  projection: (bookingId: string, signal?: AbortSignal) => Promise<CustomerConfirmationProjection>;
  programme: (bookingId: string, signal?: AbortSignal) => Promise<CustomerTrainingProgramme>;
};
const defaultDependencies: Dependencies = { projection: loadCustomerConfirmationProjection, programme: loadTrainingProgramme };

/** Read-only refresh. The account's capped booking list and pre-payment selections are not confirmation evidence. */
export async function loadVerifiedTrainingConfirmation(
  base: TrainingBookingResult,
  signal?: AbortSignal,
  dependencies: Dependencies = defaultDependencies,
): Promise<{ booking: TrainingBookingResult; programme: CustomerTrainingProgramme | null; providerName: string }> {
  signal?.throwIfAborted();
  const projection = await dependencies.projection(base.bookingId, signal);
  signal?.throwIfAborted();
  if (projection.bookingId !== base.bookingId || projection.serviceCode !== "dog_training") {
    throw new Error("The canonical Training confirmation does not match this booking.");
  }
  if (TERMINAL_FAILURES.has(projection.bookingStatus)) {
    throw new Error("This Training booking is no longer confirmed. Check Activity or contact support; do not pay again.");
  }
  if (projection.ready !== true || !CONFIRMED_STATES.has(projection.bookingStatus) ||
      !["prepaid", "split", "split_50_50"].includes(projection.paymentMode) ||
      projection.paymentStatus !== "captured" || !projection.transactionId?.trim() ||
      !projection.paymentId?.trim() || !projection.providerId?.trim() || !projection.providerName?.trim()) {
    throw new TrainingConfirmationPendingError();
  }
  if (projection.packageCode === "trainer-meet-greet") {
    return { booking: { ...base, status: projection.bookingStatus, paymentId: projection.paymentId }, programme: null, providerName: projection.providerName };
  }
  const programme = await dependencies.programme(base.bookingId, signal);
  if (programme.programme.booking_id !== base.bookingId ||
      programme.sessions.some(session => session.booking_id !== base.bookingId || session.programme_id !== programme.programme.id)) {
    throw new Error("The canonical Training programme does not match this booking.");
  }
  if (TERMINAL_FAILURES.has(programme.programme.status)) {
    throw new Error("This Training programme is no longer active. Check Activity or contact support; do not pay again.");
  }
  if (!programme.programme.id || !programme.sessions.length || programme.programme.provider_id !== projection.providerId) {
    throw new TrainingConfirmationPendingError();
  }
  signal?.throwIfAborted();
  return {
    booking: { ...base, status: projection.bookingStatus, paymentId: projection.paymentId },
    programme,
    providerName: projection.providerName,
  };
}
