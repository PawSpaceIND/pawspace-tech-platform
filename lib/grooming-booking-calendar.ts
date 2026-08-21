const INDIA_TIME_ZONE = "Asia/Kolkata";
const INDIA_OFFSET_MINUTES = 330;
const FIRST_SLOT_HOUR_IST = 9;
const LAST_SERVICE_HOUR_IST = 19;

export type GroomingBookingDate = {
  day: string;
  date: string;
  isoDate: string;
};

let fallbackSessionSequence = 0;

function indiaDateParts(value: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: INDIA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  return { year: part("year"), month: part("month"), day: part("day") };
}

function indiaCalendarDate(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month - 1, day, 12));
}

function validateSlot(slotIndex: number, durationMinutes: number) {
  const safeSlotIndex = Math.trunc(slotIndex);
  if (safeSlotIndex < 0 || safeSlotIndex > 4) throw new Error("A valid grooming slot is required");
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) throw new Error("A valid grooming duration is required");
  return safeSlotIndex;
}

export function groomingBookingDates(asOf = Date.now(), count = 4): GroomingBookingDate[] {
  const safeCount = Math.max(1, Math.min(14, Math.trunc(count)));
  const base = indiaDateParts(new Date(asOf));
  return Array.from({ length: safeCount }, (_, index) => {
    const value = indiaCalendarDate(base.year, base.month, base.day + index);
    const parts = indiaDateParts(value);
    const isoDate = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
    return {
      day: index === 0 ? "Today" : new Intl.DateTimeFormat("en-IN", { timeZone: INDIA_TIME_ZONE, weekday: "short" }).format(value),
      date: new Intl.DateTimeFormat("en-IN", { timeZone: INDIA_TIME_ZONE, day: "numeric", month: "short" }).format(value),
      isoDate,
    };
  });
}

export function groomingSlotFitsRoster(slotIndex: number, durationMinutes: number) {
  const safeSlotIndex = validateSlot(slotIndex, durationMinutes);
  const startMinutes = FIRST_SLOT_HOUR_IST * 60 + safeSlotIndex * 120;
  return startMinutes + durationMinutes <= LAST_SERVICE_HOUR_IST * 60;
}

export function groomingSlotWindow(isoDate: string, slotIndex: number, durationMinutes: number) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) throw new Error("A valid grooming booking date is required");
  const safeSlotIndex = validateSlot(slotIndex, durationMinutes);
  const [, year, month, day] = match.map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day
  ) throw new Error("A valid grooming booking date is required");
  if (!groomingSlotFitsRoster(safeSlotIndex, durationMinutes)) throw new Error("Selected grooming slot cannot finish within service hours");
  const start = new Date(
    Date.UTC(year, month - 1, day, FIRST_SLOT_HOUR_IST + safeSlotIndex * 2, 0) -
      INDIA_OFFSET_MINUTES * 60_000,
  );
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  return { start, end };
}

export function createAddressSessionToken(cryptoApi: Crypto | undefined = globalThis.crypto): string {
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  fallbackSessionSequence += 1;
  return `address-${Date.now().toString(36)}-${fallbackSessionSequence.toString(36)}`;
}
