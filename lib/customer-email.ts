/** Optional profile email validation shared by UI and canonical account writes. */
export function customerEmailIssue(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return "Enter a valid email address.";
  const email = value.trim();
  if (!email) return null;
  if (email.length > 254 || !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email)) return "Enter a valid email address.";
  return null;
}
