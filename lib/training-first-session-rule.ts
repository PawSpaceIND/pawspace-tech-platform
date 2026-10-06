/**
 * First Training session: when it may start, as the customer screens apply it.
 *
 * CUSTOMER-SIDE PRE-CHECK of the FINAL backend first-session policy (Training backend owner; the earlier
 * 24-hour row is superseded). The server enforces the same policy on every reservation; this module carries
 * the same two parameters so the screens can refuse an unschedulable choice before the customer reaches
 * payment. Nothing here is consulted by the server.
 *
 * The approved rule, in the business's words:
 *   - Two FULL preparation days must lie between the booking date and the first session. A booking
 *     made on 1 October may start on 4 October at the earliest (2 and 3 October are the two full days).
 *   - First-session starts are whole hours from 08:00 to 20:00 India Standard Time.
 *   - Both are still subject to actual trainer availability and the travel buffer, which only the
 *     scheduler can confirm.
 */
export const TRAINING_FIRST_SESSION_UI_MIRROR = {
  fullPreparationDays: 2,
  earliestHour: 8,
  latestHour: 20,
  timeZone: "Asia/Kolkata",
  mirrorOf: "final Training backend first-session policy: two full preparation days, whole hours 08:00-20:00 IST (customer-side pre-check; the server enforces it)",
  temporary: false,
} as const;

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const pad = (value: number) => String(value).padStart(2, "0");

/** The calendar date in IST for an instant, as yyyy-mm-dd. */
export function istDateOf(atMs: number): string {
  const shifted = new Date(atMs + IST_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

function istDateToUtcMidnight(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const utc = Date.UTC(year, month - 1, day);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return utc;
}

/** The earliest first-session date: the booking's IST date plus the two full days plus one. */
export function earliestFirstSessionDate(nowMs: number = Date.now()): string {
  const today = istDateToUtcMidnight(istDateOf(nowMs))!;
  return istDateOf(today + (TRAINING_FIRST_SESSION_UI_MIRROR.fullPreparationDays + 1) * DAY_MS);
}

/** The whole hours a first session may start on, 08 to 20 inclusive. */
export function firstSessionHours(): number[] {
  const hours: number[] = [];
  for (let hour = TRAINING_FIRST_SESSION_UI_MIRROR.earliestHour; hour <= TRAINING_FIRST_SESSION_UI_MIRROR.latestHour; hour += 1) hours.push(hour);
  return hours;
}

export const hourLabel = (hour: number) => `${pad(hour)}:00`;

/** An ISO-8601 start carrying the IST offset, for the scheduler and the quote. */
export function firstSessionStartIso(date: string, hour: number): string {
  return `${date}T${pad(hour)}:00:00+05:30`;
}

export type FirstSessionCheck =
  | { ok: true; startIso: string }
  | { ok: false; code: "date_invalid" | "time_invalid" | "in_past" | "inside_preparation_days" | "not_whole_hour" | "hour_outside_window" | "beyond_horizon"; reason: string };

/**
 * Whether a chosen date and time may be offered as the first session. `time` is "HH:MM" as a form
 * control gives it. Every refusal names the rule in words the customer can act on.
 */
export function checkFirstSessionSelection(input: { date: string; time: string; nowMs?: number; maxHorizonDays?: number }): FirstSessionCheck {
  const nowMs = input.nowMs ?? Date.now();
  const dayUtc = istDateToUtcMidnight(String(input.date ?? ""));
  if (dayUtc === null) return { ok: false, code: "date_invalid", reason: "Choose a date for the first session." };
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(String(input.time ?? ""));
  if (!timeMatch) return { ok: false, code: "time_invalid", reason: "Choose a start time for the first session." };
  const hour = Number(timeMatch[1]), minute = Number(timeMatch[2]);
  if (minute !== 0) return { ok: false, code: "not_whole_hour", reason: "Sessions start on the hour. Choose a whole-hour start time." };
  const { earliestHour, latestHour } = TRAINING_FIRST_SESSION_UI_MIRROR;
  if (hour < earliestHour || hour > latestHour) return { ok: false, code: "hour_outside_window", reason: `Sessions start between ${hourLabel(earliestHour)} and ${hourLabel(latestHour)} IST.` };
  const startMs = dayUtc + hour * 3_600_000 - IST_OFFSET_MS;
  if (startMs <= nowMs) return { ok: false, code: "in_past", reason: "That time has already passed. Choose a later first session." };
  const earliest = earliestFirstSessionDate(nowMs);
  if (input.date < earliest) return { ok: false, code: "inside_preparation_days", reason: `Your trainer needs two full days to prepare. The earliest first session is ${longDate(earliest)}.` };
  const horizonDays = input.maxHorizonDays ?? 180;
  if (startMs - nowMs > horizonDays * DAY_MS) return { ok: false, code: "beyond_horizon", reason: `Choose a first session within the next ${horizonDays} days.` };
  return { ok: true, startIso: firstSessionStartIso(input.date, hour) };
}

/** "4 October" for yyyy-mm-dd, in the customer's calendar words. */
export function longDate(date: string): string {
  const utc = istDateToUtcMidnight(date);
  if (utc === null) return date;
  return new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "long" }).format(new Date(utc));
}

/** The rule in plain words, with today's worked example, for the screen beside the date control. */
export function firstSessionRuleLabel(nowMs: number = Date.now()): string {
  const { earliestHour, latestHour } = TRAINING_FIRST_SESSION_UI_MIRROR;
  return `Your trainer needs two full days to prepare, so the earliest first session for a booking made today (${longDate(istDateOf(nowMs))}) is ${longDate(earliestFirstSessionDate(nowMs))}. For example, a booking made on 1 October can start on 4 October at the earliest. Sessions start on the hour, ${hourLabel(earliestHour)} to ${hourLabel(latestHour)} IST, and still depend on your trainer's availability and travel time.`;
}
