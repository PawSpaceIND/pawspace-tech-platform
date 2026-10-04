/**
 * Boarding and Pet Sitting customer screens ("Final testing 27th Sep" rows 41-59): the Plan step's time
 * rules, and what the screen says when a host or sitter search comes back empty or a reservation is refused.
 *
 * Diagnosed on this branch by executing the real preview and reserve routes against the staging capacity
 * seed (tests/stay-flow-workbook.test.mjs): a sitter search is EMPTY, with availabilityChecked:true, for any
 * date past the published roster (the staging seed publishes yesterday..+15 days), and a reserve on such a
 * date is refused SELECTED_SITTER_UNAVAILABLE with the engine's reason "Commission provider has no
 * explicitly Open calendar on <date>". The preview carries no reason, so the screen used to say only
 * "No sitter is available for this care window. Try different dates." This module gives the customer what
 * was checked, a reference for support, and the next step; it never claims a sitter exists. Browser-safe.
 */

/** Stay hand-over times are whole hours, 08:00 to 20:00 IST (workbook row decision for check-in/check-out). */
export const STAY_HANDOVER_HOURS = { earliest: 8, latest: 20 } as const;
const pad = (value: number) => String(value).padStart(2, "0");
export const stayHourLabel = (hour: number) => `${pad(hour)}:00`;

/** The 1-hour emergency path the workbook names is not a self-service booking: the scheduler needs 24 hours. */
export const EMERGENCY_CARE_NOTE = "Need care within the hour? The emergency path is handled by PawSpace support, not by this screen: this booking needs 24 hours' notice.";

export type StayTimeProblem = { code: "start_not_whole_hour" | "start_outside_hours" | "end_not_whole_hour" | "end_outside_hours"; message: string };

function hourProblem(label: "Check-in" | "Check-out", time: string): StayTimeProblem | null {
  const match = /^(\d{2}):(\d{2})$/.exec(String(time ?? ""));
  if (!match) return null; // An unparseable time is already "Choose a check-out after check-in."
  const hour = Number(match[1]), minute = Number(match[2]);
  const which = label === "Check-in" ? "start" : "end";
  if (minute !== 0) return { code: `${which}_not_whole_hour`, message: `${label} is on the hour. Choose a whole hour such as ${stayHourLabel(Math.min(STAY_HANDOVER_HOURS.latest, Math.max(STAY_HANDOVER_HOURS.earliest, hour)))}.` };
  if (hour < STAY_HANDOVER_HOURS.earliest || hour > STAY_HANDOVER_HOURS.latest) return { code: `${which}_outside_hours`, message: `${label} is between ${stayHourLabel(STAY_HANDOVER_HOURS.earliest)} and ${stayHourLabel(STAY_HANDOVER_HOURS.latest)} IST.` };
  return null;
}

/** Whole-hour, 08:00-20:00 check-in and check-out. A Home Visit has no check-out of its own. */
export function stayTimeProblem(input: { startTime: string; endTime: string; visitMode: boolean }): StayTimeProblem | null {
  return hourProblem("Check-in", input.startTime) ?? (input.visitMode ? null : hourProblem("Check-out", input.endTime));
}

export type StayPastProblem = { code: "in_past"; message: string };
/** A check-in that has already passed, named as such rather than as "not enough notice". */
export function stayPastProblem(scheduledStart: Date | number, now = Date.now()): StayPastProblem | null {
  const start = scheduledStart instanceof Date ? scheduledStart.getTime() : Number(scheduledStart);
  if (!Number.isFinite(start) || start > now) return null;
  return { code: "in_past", message: "That check-in has already passed. Choose a date and time from now on." };
}

export type StaySearchDiagnosis = { reference: string; headline: string; checked: string[]; nextSteps: string[] };

/**
 * An EMPTY search that finished (not a timed-out or failed one; those keep their own retry copy).
 * Everything here is what the screen itself sent or received; nothing is guessed about the roster.
 */
export function staySearchDiagnosis(input: { mode: "boarding" | "sitting"; zoneId?: string; area?: string; date: string; startTime: string; windowSummary: string; careMode: "visit" | "overnight" | "daycare"; petCount: number; species: string[]; requirements?: string[] }): StaySearchDiagnosis {
  const who = input.mode === "sitting" ? "sitter" : "host";
  const zone = (input.zoneId || "zone").replace(/[^a-z0-9-]/gi, "");
  const reference = `${input.mode === "sitting" ? "SIT" : "BRD"}-EMPTY-${zone}-${input.date}-${input.startTime.replace(":", "")}-${input.careMode}-${input.petCount}P`;
  const checked = [
    `Area: ${input.area || input.zoneId || "your verified service address"}`,
    `Care window (IST): ${input.windowSummary}`,
    `Care: ${input.careMode === "visit" ? "one 60-minute Home Visit" : input.careMode === "overnight" ? "overnight" : "daycare"} for ${input.petCount} ${input.petCount === 1 ? "pet" : "pets"} (${input.species.join(", ") || "species not set"})`,
    ...(input.requirements?.length ? [`Must-haves: ${input.requirements.join(", ")}`] : []),
    "The schedule check finished; this is not a timeout.",
  ];
  const nextSteps = input.mode === "sitting"
    ? ["Sitters are shown only for dates and hours they have published. Try a nearer date or a different hour, then search again.", "Keep the reference below if you ask PawSpace support why no sitter was listed."]
    : ["Hosts are shown only when a verified home has capacity for every selected pet across the whole stay. Try different dates, fewer must-haves, or a shorter stay.", "Keep the reference below if you ask PawSpace support why no host was listed."];
  return { reference, headline: `No ${who} has published availability covering this care window in ${input.area || "your area"}.`, checked, nextSteps };
}

export type StayReservationDiagnosis = { code: string; headline: string; action: string; goTo: "plan" | "caregiver" | "address" | null; retry: boolean };

const RESERVATION_DIAGNOSES: Record<string, Omit<StayReservationDiagnosis, "code">> = {
  host_selection_required: { headline: "No host or sitter was selected for this request.", action: "Go back and choose an available host or sitter, then confirm again.", goTo: "caregiver", retry: false },
  provider_selection_required: { headline: "No caregiver was selected for this request.", action: "Go back and choose an available caregiver, then confirm again.", goTo: "caregiver", retry: false },
  SELECTED_SITTER_UNAVAILABLE: { headline: "Your selected sitter has no published availability for this window any more.", action: "Search again and choose another sitter, or change the date or time.", goTo: "caregiver", retry: false },
  SELECTED_PROVIDER_UNAVAILABLE: { headline: "Your selected caregiver is no longer available for this window.", action: "Search again and choose another caregiver, or change the date or time.", goTo: "caregiver", retry: false },
  SLOT_TAKEN: { headline: "Another booking took this caregiver's slot a moment ago.", action: "Search again for the same window, or choose another time.", goTo: "caregiver", retry: true },
  NO_SCHEDULE_AVAILABLE: { headline: "No caregiver can take this window.", action: "Choose different dates or times on the Plan step.", goTo: "plan", retry: false },
  below_minimum_lead_time: { headline: "This stay starts too soon for the scheduler.", action: "Choose a check-in at least 24 hours from now.", goTo: "plan", retry: false },
  beyond_booking_horizon: { headline: "This stay starts further ahead than bookings are open.", action: "Choose an earlier check-in date.", goTo: "plan", retry: false },
  beyond_maximum_stay: { headline: "A single stay cannot run this long.", action: "Shorten the stay, or book it as two stays.", goTo: "plan", retry: false },
  scheduling_group_window_conflict: { headline: "This request already holds a different care window.", action: "Check Activity for the earlier request before trying a different time.", goTo: null, retry: false },
  SERVICE_ADDRESS_REQUIRED: { headline: "No verified service address was sent with this request.", action: "Verify your service address on the Plan step, then confirm again.", goTo: "address", retry: false },
  SERVICE_ADDRESS_UNVERIFIED: { headline: "Your service address could not be verified for this service.", action: "Check the address and PIN on the Plan step, then confirm again.", goTo: "address", retry: false },
  RESERVE_UNREACHABLE: { headline: "The reservation request never reached PawSpace.", action: "Check your connection and confirm again. Nothing was reserved or charged.", goTo: null, retry: true },
  RESERVE_UNREADABLE: { headline: "PawSpace answered, but the answer could not be read.", action: "Confirm again. Check Activity before paying twice.", goTo: null, retry: true },
  SCHEDULING_BUSY: { headline: "Scheduling is busy for a moment.", action: "Wait a few seconds and confirm again.", goTo: null, retry: true },
};

/** The refusal behind a failed confirm, read from the error's recognised code; null for anything unrecognised. */
export function stayReservationDiagnosis(error: unknown): StayReservationDiagnosis | null {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  const known = code && RESERVATION_DIAGNOSES[code];
  return known ? { code, ...known } : null;
}
