/**
 * Customer wording for a Training session's status. Sessions after the first are stored as "locked" until the
 * previous one is done, and the first as "scheduled"; to the customer both are simply reserved at their times.
 */
const CUSTOMER_SESSION_STATUS: Readonly<Record<string, string>> = {
  locked: "reserved",
  scheduled: "reserved",
  accepted: "trainer confirmed",
  on_the_way: "trainer on the way",
  arrived: "trainer arrived",
  in_session: "in progress",
  in_progress: "in progress",
  completed: "completed",
  cancelled: "cancelled",
  reschedule_requested: "reschedule requested",
  no_show: "missed",
};

export function customerTrainingSessionStatus(status: string | null | undefined): string {
  const key = String(status ?? "").trim().toLowerCase();
  return CUSTOMER_SESSION_STATUS[key] ?? key.replaceAll("_", " ");
}

/** "1 session", "8 sessions". */
export function trainingSessionCount(count: number): string {
  return `${count} session${count === 1 ? "" : "s"}`;
}
