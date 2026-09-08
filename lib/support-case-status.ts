/** Both ticket stores use these terminal states. Unknown states remain actionable. */
export function isSupportCaseOpen(status: unknown) {
  return !["resolved", "closed"].includes(String(status));
}
