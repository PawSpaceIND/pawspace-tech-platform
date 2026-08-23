/**
 * The outbound/inbound voice call lifecycle, as an explicit state machine.
 *
 * Before this, a call had four statuses (active | transferred | failed | completed) written by direct
 * UPDATEs, so nothing stopped a completed call being "failed" afterwards, a blocked call being dialled,
 * or a call jumping straight to connected without a policy check ever having run. The audit trail could
 * therefore describe a sequence of events that cannot physically happen, which makes it useless as
 * evidence.
 *
 * Every transition a call may make is enumerated here and nowhere else. The governance layer asks this
 * module before it writes, so an impossible transition is refused rather than recorded.
 */

export type VoiceCallState =
  // happy path
  | "requested" | "policy_check" | "queued" | "dialing" | "ringing" | "connected"
  | "speaking" | "listening" | "handoff_requested" | "completed" | "ended"
  // refused before any dial happened - each one is a distinct, terminal, auditable reason
  | "blocked_disabled" | "blocked_permission" | "blocked_use_case" | "blocked_not_allowlisted"
  | "blocked_consent" | "blocked_opt_out" | "blocked_quiet_hours" | "blocked_frequency_cap"
  // failures that can only occur once we started trying
  | "provider_unavailable" | "dial_failed" | "no_answer" | "busy"
  | "stt_failed" | "tts_failed" | "ai_handoff" | "provider_error" | "cancelled";

/**
 * Adjacency, exhaustive. A state absent from a source's list is not reachable from it - including
 * the state itself, so a re-delivered provider event cannot be recorded as a self-transition.
 */
export const VOICE_CALL_TRANSITIONS: Readonly<Record<VoiceCallState, readonly VoiceCallState[]>> = {
  requested: ["policy_check", "cancelled"],
  // Every pre-dial refusal is decided here and only here: nothing downstream of policy_check can
  // reach a blocked_* state, so a blocked call in the ledger is proof the gate ran before the dial.
  policy_check: [
    "queued", "cancelled", "provider_unavailable",
    "blocked_disabled", "blocked_permission", "blocked_use_case", "blocked_not_allowlisted",
    "blocked_consent", "blocked_opt_out", "blocked_quiet_hours", "blocked_frequency_cap",
  ],
  queued: ["dialing", "cancelled", "provider_unavailable", "provider_error"],
  dialing: ["ringing", "connected", "dial_failed", "busy", "no_answer", "provider_error", "cancelled"],
  ringing: ["connected", "no_answer", "busy", "dial_failed", "provider_error", "cancelled"],
  connected: ["speaking", "listening", "handoff_requested", "completed", "stt_failed", "tts_failed", "provider_error", "cancelled"],
  speaking: ["listening", "connected", "handoff_requested", "completed", "stt_failed", "tts_failed", "provider_error", "cancelled"],
  listening: ["speaking", "connected", "handoff_requested", "completed", "stt_failed", "tts_failed", "provider_error", "cancelled"],
  // A handoff is a promise to a human. It may only resolve into an actual handoff, a completed call
  // or a provider error - never back into the bot talking.
  handoff_requested: ["ai_handoff", "completed", "provider_error"],
  completed: ["ended"],
  ended: [],
  blocked_disabled: [], blocked_permission: [], blocked_use_case: [], blocked_not_allowlisted: [],
  blocked_consent: [], blocked_opt_out: [], blocked_quiet_hours: [], blocked_frequency_cap: [],
  provider_unavailable: ["ended"],
  dial_failed: ["ended"],
  no_answer: ["ended"],
  busy: ["ended"],
  // A speech-stack failure mid-call is exactly when a human should take over, so the handoff route
  // stays open from here; it is not silently a dead end.
  stt_failed: ["handoff_requested", "ended"],
  tts_failed: ["handoff_requested", "ended"],
  ai_handoff: ["ended"],
  provider_error: ["ended"],
  cancelled: ["ended"],
};

export const VOICE_CALL_STATES = Object.keys(VOICE_CALL_TRANSITIONS) as VoiceCallState[];

/** Refused before the provider was ever contacted. No provider traffic exists for these calls. */
export const VOICE_BLOCKED_STATES = VOICE_CALL_STATES.filter(state => state.startsWith("blocked_"));

/** Nothing may follow these. */
export const VOICE_TERMINAL_STATES = VOICE_CALL_STATES.filter(state => VOICE_CALL_TRANSITIONS[state].length === 0);

/** States where the call is over but the ledger row is not yet closed out. */
export const VOICE_FAILURE_STATES: VoiceCallState[] = [
  ...VOICE_BLOCKED_STATES, "provider_unavailable", "dial_failed", "no_answer", "busy",
  "stt_failed", "tts_failed", "ai_handoff", "provider_error", "cancelled",
];

/**
 * Failures worth trying again, and only these. A consent, opt-out, quiet-hours or allow-list refusal
 * is a decision, not a transient fault: retrying it would be dialling someone the policy just said
 * not to dial.
 */
export const VOICE_RETRYABLE_STATES: VoiceCallState[] = ["dial_failed", "no_answer", "busy", "provider_unavailable", "provider_error"];

export function isVoiceCallState(value: unknown): value is VoiceCallState {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(VOICE_CALL_TRANSITIONS, value);
}

export function canVoiceCallTransition(from: VoiceCallState, to: VoiceCallState): boolean {
  return VOICE_CALL_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Throws rather than returning false, so a caller cannot accidentally ignore the answer. */
export function assertVoiceCallTransition(from: unknown, to: unknown): { from: VoiceCallState; to: VoiceCallState } {
  if (!isVoiceCallState(from)) throw new Error(`Unknown voice call state: ${String(from)}`);
  if (!isVoiceCallState(to)) throw new Error(`Unknown voice call state: ${String(to)}`);
  if (!canVoiceCallTransition(from, to)) throw new Error(`Illegal voice call transition ${from} -> ${to}`);
  return { from, to };
}

/** A coarse, stable class for reporting - the specific state stays on the transition row. */
export function voiceFailureReasonClass(state: VoiceCallState): string | null {
  if (state.startsWith("blocked_")) return "policy_blocked";
  switch (state) {
    case "provider_unavailable": return "provider_not_configured";
    case "dial_failed": case "provider_error": return "provider_error";
    case "no_answer": case "busy": return "not_reached";
    case "stt_failed": case "tts_failed": return "speech_stack_failure";
    case "ai_handoff": return "human_handoff";
    case "cancelled": return "cancelled_by_operator";
    default: return null;
  }
}
