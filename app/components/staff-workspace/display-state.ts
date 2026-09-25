/** Presentation-only values. Never calculates balances or changes access rights. */
export function snapshotMetric(value: string | number | null | undefined, loading: boolean, error: unknown): string | number {
  if (loading || Boolean(error) || value == null || (typeof value === "number" && !Number.isFinite(value))) return "\u2014";
  return value;
}

export function controlSignalLabel(severity: unknown): string {
  if (severity === "critical") return "Action required";
  if (severity === "attention") return "Needs attention";
  if (severity === "clear") return "Clear";
  return "Status unavailable";
}

export type NavigationSnapshot<T> = {
  pathname: string;
  attempt: number;
  actor: T | null;
  error: string;
  signInUrl: string;
  status: number;
};
/** Old route/retry results are not evidence for the current menu. */
export function currentNavigationSnapshot<T>(snapshot: NavigationSnapshot<T> | null, pathname: string, attempt: number): NavigationSnapshot<T> | null {
  return snapshot?.pathname === pathname && snapshot.attempt === attempt ? snapshot : null;
}
