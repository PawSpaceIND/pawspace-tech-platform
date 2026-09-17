/** Classify transient Cloudflare D1 remote-execute failures that are safe to retry.
 * Retry means re-running the exact replay-safe migration; it never skips or marks work successful.
 */
export function classifyRemoteD1Retry(detail) {
  const text = String(detail ?? "");
  if (text.includes("D1_RESET_DO")) return { retryable: true, reason: "D1_RESET_DO" };
  if (text.includes("Not currently importing anything.")) {
    return { retryable: true, reason: "D1 import-state race" };
  }
  return { retryable: false, reason: "non-transient D1 error" };
}
