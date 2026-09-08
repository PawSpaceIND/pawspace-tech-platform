export class InboxUiError extends Error {}

export function inboxResponseError(status: number): InboxUiError {
  const message = status === 401 ? "Please sign in again to continue helping this pet parent."
    : status === 403 ? "Your role cannot make this change. Please ask your team lead for help."
    : status === 404 ? "This conversation is no longer available. Choose another from the inbox."
    : status === 409 ? "This conversation has changed or a messaging rule needs attention. Review its current routing and reply window before trying again."
    : status === 429 ? "Please give us a moment before trying again."
    : "We couldn't complete that request. Check the conversation before retrying.";
  return new InboxUiError(message);
}

export function inboxErrorMessage(cause: unknown): string {
  return cause instanceof InboxUiError ? cause.message
    : "We couldn't confirm the latest update. Check your connection and review the conversation before retrying.";
}
