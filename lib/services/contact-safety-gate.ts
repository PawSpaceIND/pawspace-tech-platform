export type ContactEligibilityDecision = "Allowed" | "Suppressed" | "Review Required";

export type ContactSafetyReason =
  | "customer_opted_out"
  | "open_complaint"
  | "quiet_hours"
  | "invalid_timezone"
  | "invalid_quiet_hours_policy";

export interface QuietHoursPolicy {
  timezone: string;
  startMinute: number;
  endMinute: number;
}

export interface ContactEligibilityInput {
  optedOut: boolean;
  openComplaint: boolean;
  quietHours?: QuietHoursPolicy | null;
  evaluatedAt?: number | Date;
}

export interface ContactEligibilityResult {
  decision: ContactEligibilityDecision;
  reasons: ContactSafetyReason[];
  evaluatedAt: number;
}

function normalizeTimestamp(value: number | Date | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return Date.now();
}

function validMinute(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < 1_440;
}

function localMinute(timestamp: number, timezone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(timestamp));
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0) % 24;
    const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
    return hour * 60 + minute;
  } catch {
    return null;
  }
}

function fallsInsideQuietHours(minute: number, startMinute: number, endMinute: number): boolean {
  if (startMinute === endMinute) return false;
  if (startMinute < endMinute) return minute >= startMinute && minute < endMinute;
  return minute >= startMinute || minute < endMinute;
}

export function evaluateContactEligibility(input: ContactEligibilityInput): ContactEligibilityResult {
  const evaluatedAt = normalizeTimestamp(input.evaluatedAt);
  const reasons: ContactSafetyReason[] = [];

  if (input.optedOut) reasons.push("customer_opted_out");
  if (input.openComplaint) reasons.push("open_complaint");

  if (input.quietHours) {
    const { timezone, startMinute, endMinute } = input.quietHours;
    if (!timezone.trim() || !validMinute(startMinute) || !validMinute(endMinute)) {
      return {
        decision: "Review Required",
        reasons: [...reasons, "invalid_quiet_hours_policy"],
        evaluatedAt,
      };
    }

    const minute = localMinute(evaluatedAt, timezone);
    if (minute === null) {
      return {
        decision: "Review Required",
        reasons: [...reasons, "invalid_timezone"],
        evaluatedAt,
      };
    }

    if (fallsInsideQuietHours(minute, startMinute, endMinute)) reasons.push("quiet_hours");
  }

  if (reasons.length > 0) return { decision: "Suppressed", reasons, evaluatedAt };
  return { decision: "Allowed", reasons: [], evaluatedAt };
}
