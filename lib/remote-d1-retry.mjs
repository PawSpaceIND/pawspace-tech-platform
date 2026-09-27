/** Classify transient Cloudflare D1 remote-execute failures that are safe to retry.
 * Retry means re-running the exact replay-safe migration; it never skips or marks work successful.
 */
export function classifyRemoteD1Retry(detail) {
  const text = String(detail ?? "");
  if (text.includes("D1_RESET_DO")) return { retryable: true, reason: "D1_RESET_DO" };
  if (text.includes("Not currently importing anything.")) {
    return { retryable: true, reason: "D1 import-state race" };
  }
  // Refused before anything ran: another deploy's `--file` import holds the database, or D1 is
  // overloaded. Sending the same replay-safe SQL again once it is free is exactly what is wanted.
  if (text.includes("Currently processing a long-running import")) {
    return { retryable: true, reason: "D1 busy with another import" };
  }
  if (/D1 DB is overloaded|Too many requests queued/.test(text)) return { retryable: true, reason: "D1 overloaded" };
  return { retryable: false, reason: "non-transient D1 error" };
}
