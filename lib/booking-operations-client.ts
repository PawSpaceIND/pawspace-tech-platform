export type BookingOperationAction =
  | "package_upgrade"
  | "service_overrun"
  | "running_late"
  | "vehicle_issue"
  | "rebook_requested"
  | "refund_requested"
  | "refund_status";

export type BookingOperationResult = {
  eventId: string;
  bookingId: string;
  action: BookingOperationAction;
  impactMinutes: number;
  impactedBookings: Array<{ bookingId: string; customerId: string; scheduledStart: string }>;
  notificationsQueued: number;
  rebookingAvailable: boolean;
  refundCaseId?: string;
};

export async function recordBookingOperation(input: {
  bookingId: string;
  providerId: string;
  action: BookingOperationAction;
  reason: string;
  impactMinutes?: number;
  upgradedPackageName?: string;
  upgradedAmount?: number;
  refundCaseId?: string;
  refundStatus?: "approved" | "processing" | "completed" | "rejected";
  gatewayReference?: string;
}) {
  const response = await fetch("/api/booking-operations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json()) as {
    data?: BookingOperationResult;
    error?: string;
  };
  if (!response.ok || !body.data)
    throw new Error(body.error ?? "The order update could not be saved");
  return body.data;
}
