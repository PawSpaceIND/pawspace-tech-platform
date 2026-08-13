/**
 * A read that fails and returns an empty list is the most dangerous shape in this codebase.
 *
 * /team/analytics counted 331 bookings and Rs 3,24,472 of GMV next to "Collected Rs 0". Nothing was
 * broken on screen: the payments read had asked D1 for 331 bound parameters, D1 refused, a `catch`
 * swallowed it, and zero rows became zero rupees. A number nobody could distinguish from the truth.
 *
 * Swallowing is still the right behaviour - one absent module must not take a whole dashboard down -
 * but it has to be *recorded*. A report that could not read its payments has to say so, so the screen
 * can show "payments could not be read" instead of a confident zero.
 *
 * Usage: create one log per report, hand it to every guarded read, and return `log.entries()` in the
 * payload. Callers render it; tests assert it is empty on a healthy database and populated on a sick
 * one.
 */
export type DegradedRead = { source: string; reason: string };

export type DegradationLog = {
  /** Records that `source` could not be read. Returns the fallback so call sites stay one-liners. */
  note<T>(source: string, error: unknown, fallback: T): T;
  entries(): DegradedRead[];
  /** True when any read failed, so a caller can refuse to publish a total it cannot stand behind. */
  degraded(): boolean;
};

const reason = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // Keep it short and free of bound values: this reaches an operator's screen.
  return message.replace(/\s+/g, " ").trim().slice(0, 160) || "unknown error";
};

export function createDegradationLog(): DegradationLog {
  const seen = new Map<string, DegradedRead>();
  return {
    note(source, error, fallback) {
      const entry = { source, reason: reason(error) };
      // One entry per source: a chunked read that fails eight times is one broken source, not eight.
      if (!seen.has(source)) seen.set(source, entry);
      return fallback;
    },
    entries: () => [...seen.values()],
    degraded: () => seen.size > 0,
  };
}

/**
 * Formats the log for a screen. Deliberately names the source rather than the SQL: an operator needs
 * to know which number is untrustworthy, not which statement failed.
 */
export function degradationNotice(entries: DegradedRead[]) {
  if (!entries.length) return null;
  const sources = entries.map((entry) => entry.source);
  return {
    headline: sources.length === 1
      ? `${sources[0]} could not be read, so any figure derived from it is missing rather than zero.`
      : `${sources.length} sources could not be read, so figures derived from them are missing rather than zero.`,
    sources,
    entries,
  };
}
