/**
 * The operator console's dial decision, as a function rather than as a JSX expression.
 *
 * The console must not offer a dial the governance layer would refuse, and must not carry a policy
 * decision from one recipient to another. Both of those are safety properties, and a safety property
 * expressed inline in a `disabled={...}` attribute can only be checked by reading the markup - which
 * is how "the button was disabled" and "the button was disabled for the right reason" become
 * indistinguishable. Everything the console decides about whether a dial may be offered lives here and
 * is executed directly by tests/voice-operator-console.test.mjs.
 *
 * This is a client-side convenience, never an authority: `/api/voice-outbound` re-runs the full gate
 * server-side and refuses independently. A console that got every decision here wrong could still not
 * place a call the environment forbids.
 */

export type OperatorForm = { useCase: string; phone: string; cityId: string; customerId: string; leadId: string; bookingId: string };

export type OperatorGate = {
  enabled: boolean;
  blockedReason: string | null;
  salesOutboundApproved: boolean;
};

export type OperatorUseCase = { code: string; label: string; requiresBooking: boolean; requiresSalesApproval: boolean; availableNow: boolean };

export type OperatorPreview = { for: OperatorForm; result: { allowed: boolean; blockedBy: string | null }; idempotencyKey: string };

const FORM_FIELDS: Array<keyof OperatorForm> = ["useCase", "phone", "cityId", "customerId", "leadId", "bookingId"];

export const trimmedForm = (form: OperatorForm): OperatorForm =>
  FORM_FIELDS.reduce((out, field) => ({ ...out, [field]: String(form[field] ?? "").trim() }), {} as OperatorForm);

/**
 * Whether a held preview was run against exactly this request. Compared field by field on trimmed
 * values: a preview for one number must never authorise a dial to another, and whitespace is not a
 * different recipient.
 */
export function previewMatchesForm(preview: OperatorPreview | null, form: OperatorForm): boolean {
  if (!preview) return false;
  const held = trimmedForm(preview.for), current = trimmedForm(form);
  return FORM_FIELDS.every(field => held[field] === current[field]);
}

export type DialDecision = {
  /** The dry-run policy check may be offered: it creates nothing and dials nothing. */
  canPreview: boolean;
  /** A dial may be offered. */
  canDial: boolean;
  /** Why not, most decisive first. Rendered to the operator, so each entry is an actionable sentence. */
  reasons: string[];
  /** The key to send, so every attempt at one composed request collapses onto one call. */
  idempotencyKey: string | null;
};

export function operatorDialDecision(input: { gate: OperatorGate | null; useCases: OperatorUseCase[]; form: OperatorForm; preview: OperatorPreview | null }): DialDecision {
  const reasons: string[] = [];
  const form = trimmedForm(input.form);
  const useCase = input.useCases.find(entry => entry.code === form.useCase) ?? null;

  if (!input.gate) reasons.push("Environment state has not loaded yet.");
  else if (!input.gate.enabled) reasons.push(input.gate.blockedReason || "Calling is disabled by the environment.");

  if (!form.useCase) reasons.push("Select a use case.");
  else if (!useCase) reasons.push("That use case is not registered.");
  else if (!useCase.availableNow) reasons.push(`${useCase.label} needs outbound sales approval before it can be used.`);
  else if (useCase.requiresBooking && !form.bookingId) reasons.push(`${useCase.label} requires the booking it refers to.`);

  if (!form.phone) reasons.push("Enter the recipient number.");
  if (!form.customerId && !form.leadId) reasons.push("A customer ID or a lead ID is required.");

  // A preview is only ever a reason to ENABLE a dial, never a reason to allow one the checks above
  // already refused - so it is evaluated last and cannot clear anything.
  const canPreview = reasons.length === 0;
  const matched = previewMatchesForm(input.preview, input.form);
  if (canPreview) {
    if (!input.preview) reasons.push("Run a policy check for this request first.");
    else if (!matched) reasons.push("The request changed since the last policy check. Check policy again.");
    else if (!input.preview.result.allowed) reasons.push(`Policy blocked this call: ${input.preview.result.blockedBy || "refused"}.`);
  }

  const canDial = canPreview && matched && Boolean(input.preview?.result.allowed);
  return { canPreview, canDial, reasons, idempotencyKey: canDial ? input.preview!.idempotencyKey : null };
}

/** The only rendering of a recipient number the console does. The API returns no more than this. */
export const maskedNumber = (last4: unknown) => `••••${String(last4 ?? "").slice(-4).padStart(4, "•")}`;
