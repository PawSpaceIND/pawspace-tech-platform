// Presentation only: these labels never authorize messaging.
export function consentEvidenceLabel(applicable: boolean, status: unknown): string {
  if (!applicable) return "Not available for this conversation";
  if (typeof status !== "string") return "Not provided · check consent before messaging";
  const labels: Record<string, string> = {
    opted_out: "Opt-out reported · do not message",
    revoked: "Consent withdrawn · do not message",
    denied: "Consent denied · do not message",
    granted: "Consent reported · server policy still applies",
    verified: "Verification reported · server policy still applies",
    pending: "Consent pending · not confirmed",
  };
  return labels[status.trim().toLowerCase()] || "Not confirmed · check consent before messaging";
}

export class CustomerChatUiError extends Error {}
export function customerChatResponseError(status: number): CustomerChatUiError {
  return new CustomerChatUiError(status === 401 ? "Please sign in again to continue your conversation."
    : status === 403 ? "We couldn't open this conversation for your account. Please check that you're signed in to the right account."
    : status === 429 ? "Please give us a moment, then try again."
    : "We couldn't confirm a reply. Please check the conversation before sending again.");
}
export function customerChatErrorMessage(cause: unknown): string {
  return cause instanceof CustomerChatUiError ? cause.message
    : "We're having trouble connecting. Please check your connection and the conversation before sending again.";
}
