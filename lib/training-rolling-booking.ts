/**
 * Booking the next appointment of a rolling Training programme from the customer screens, against the FROZEN
 * backend contract in lib/training-programme-client.ts:
 *
 *   loadTrainingRollingSummary(bookingId, signal?) -> { canSchedule, validFrom, validUntil, remainingSessions,
 *     remainingUnallocatedSessions?, maxUpcomingSessions, upcomingSessions, holds, availableSlots:[{start,end}],
 *     availabilityWindow, providerId }
 *   sendTrainingRollingAction({ bookingId, actorKind:'customer', action:'hold'|'confirm'|'propose_change'|
 *     'accept_change'|'reject_change', idempotencyKey, slots?, holdId?, sessionId?, reason?, changeId? })
 *
 * Booking = hold (one server-offered slot, stable key) -> holdId/expiresAt -> confirm (holdId, a DISTINCT stable
 * confirm key) -> sessionIds/status -> refresh the authoritative summary. An ambiguous confirm (no readable answer)
 * is retried with the SAME hold and confirm key; a definite refusal that names the hold as gone, or a hold past
 * its expiry, needs a fresh hold. Nothing is ever reported as booked unless the server's answer says so.
 *
 * The frozen helpers are bound structurally so the screens compile on a base that predates them; on such a base
 * the client reports "not available in this build" instead of posting anything. Browser-safe.
 */
import * as programmeClient from "./training-programme-client";

export type RollingSlot = { start: string; end: string };
export type RollingSummary = {
  canSchedule: boolean;
  validFrom?: string | number | null;
  validUntil?: string | number | null;
  remainingSessions: number;
  remainingUnallocatedSessions?: number | null;
  maxUpcomingSessions: number;
  upcomingSessions: Array<{ id?: string; sessionId?: string; start?: string; end?: string; scheduled_start?: string; scheduled_end?: string; status?: string }>;
  holds: Array<{ holdId?: string; id?: string; expiresAt?: number | string | null; slots?: RollingSlot[] }>;
  availableSlots: RollingSlot[];
  availabilityWindow?: unknown;
  providerId: string | null;
};
export type RollingAction = "hold" | "confirm" | "propose_change" | "accept_change" | "reject_change";
export type RollingActionInput = { bookingId: string; actorKind: "customer"; action: RollingAction; idempotencyKey: string; slots?: RollingSlot[]; holdId?: string; sessionId?: string; reason?: string; changeId?: string };
export type RollingActionResult = { holdId?: string; expiresAt?: number | string | null; sessionIds?: string[]; status?: string; [key: string]: unknown };
export type RollingClient = {
  loadSummary(bookingId: string, signal?: AbortSignal): Promise<RollingSummary>;
  sendAction(input: RollingActionInput): Promise<RollingActionResult>;
};

type FrozenExports = { loadTrainingRollingSummary?: (bookingId: string, signal?: AbortSignal) => Promise<RollingSummary>; sendTrainingRollingAction?: (input: RollingActionInput) => Promise<RollingActionResult> };
export const ROLLING_NOT_IN_BUILD = "Booking the next appointment is not available in this build yet.";

/** The frozen client, or one that refuses plainly when this build predates the frozen helpers. */
export function frozenRollingClient(): RollingClient {
  const exports = programmeClient as unknown as FrozenExports;
  return {
    loadSummary: (bookingId, signal) => exports.loadTrainingRollingSummary ? exports.loadTrainingRollingSummary(bookingId, signal) : Promise.reject(new Error(ROLLING_NOT_IN_BUILD)),
    sendAction: (input) => exports.sendTrainingRollingAction ? exports.sendTrainingRollingAction(input) : Promise.reject(new Error(ROLLING_NOT_IN_BUILD)),
  };
}

export const toMs = (value: string | number | null | undefined): number | null => {
  if (value == null) return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

export type RollingGate = { ok: true } | { ok: false; reason: string };
/** Whether the customer may book now. Every refusal names the rule in the customer's words. */
export function rollingScheduleGate(input: { assignmentState: string; summary: RollingSummary | null; now?: number }): RollingGate {
  if (input.assignmentState !== "assigned") return { ok: false, reason: "Your next appointment can be booked once your trainer is assigned." };
  const summary = input.summary;
  if (!summary) return { ok: false, reason: "Loading your programme's schedule…" };
  if (!summary.providerId) return { ok: false, reason: "Your next appointment can be booked once your trainer is assigned." };
  if (summary.canSchedule !== true) return { ok: false, reason: "Scheduling is paused for this programme. PawSpace will contact you if anything is needed." };
  const remaining = summary.remainingUnallocatedSessions ?? summary.remainingSessions;
  if (!(remaining > 0)) return { ok: false, reason: "Every purchased session is already scheduled or used." };
  if (summary.upcomingSessions.length >= summary.maxUpcomingSessions) return { ok: false, reason: `You can have up to ${summary.maxUpcomingSessions} upcoming ${summary.maxUpcomingSessions === 1 ? "session" : "sessions"} at a time. Book the next one after one is completed.` };
  const until = toMs(summary.validUntil), now = input.now ?? Date.now();
  if (until != null && until <= now) return { ok: false, reason: "Your programme's validity has ended. Contact PawSpace about your remaining sessions." };
  if (!summary.availableSlots.length) return { ok: false, reason: "Your trainer has no open slot to offer right now. Check again later." };
  return { ok: true };
}

export type RollingPhase = "idle" | "loading" | "ready" | "holding" | "held" | "confirming" | "confirmed";
export type RollingState = {
  phase: RollingPhase;
  summary: RollingSummary | null;
  slot: RollingSlot | null;
  hold: { holdId: string; expiresAt: number | null; slot: RollingSlot } | null;
  /** The last outcome, in words; never a success claim unless the server confirmed. */
  message: string;
  error: string;
  confirmedSessionIds: string[];
};

const HOLD_GONE = /expired|not found|unknown hold|invalid hold|no longer held|released/i;
/** Only these exact statuses (or returned session ids) mean the server confirmed; unknown or negative statuses do not. */
const CONFIRMED_STATUSES = new Set(["confirmed", "booked", "scheduled"]);
export const isConfirmedAnswer = (result: RollingActionResult) => (Array.isArray(result.sessionIds) && result.sessionIds.length > 0) || CONFIRMED_STATUSES.has(String(result.status ?? "").trim().toLowerCase());

/**
 * The booking machine behind the Next appointment control. Pure of React so it can be exercised directly.
 */
export function createRollingBooking(input: { bookingId: string; client: RollingClient; now?: () => number; random?: () => string; onChange?: (state: RollingState) => void }) {
  const now = input.now ?? (() => Date.now());
  const random = input.random ?? (() => (typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`));
  const holdKeys = new Map<string, string>();
  const confirmKeys = new Map<string, string>();
  let state: RollingState = { phase: "idle", summary: null, slot: null, hold: null, message: "", error: "", confirmedSessionIds: [] };
  const set = (patch: Partial<RollingState>) => { state = { ...state, ...patch }; input.onChange?.(state); };
  const slotKey = (slot: RollingSlot) => `${slot.start}|${slot.end}`;
  const plain = (problem: unknown, fallback: string) => problem instanceof Error && problem.message ? problem.message : fallback;

  return {
    get state() { return state; },
    holdKeyFor(slot: RollingSlot) { const key = slotKey(slot); if (!holdKeys.has(key)) holdKeys.set(key, `training-hold:${random()}`); return holdKeys.get(key)!; },
    confirmKeyFor(holdId: string) { if (!confirmKeys.has(holdId)) confirmKeys.set(holdId, `training-confirm:${random()}`); return confirmKeys.get(holdId)!; },
    holdExpired() { return Boolean(state.hold && state.hold.expiresAt != null && state.hold.expiresAt <= now()); },
    /** Reload the authoritative summary. A held or just-confirmed state, and its words, survive the refresh. */
    async load(signal?: AbortSignal, preserveOutcome = false) {
      const keep = preserveOutcome || Boolean(state.hold) || state.phase === "confirmed" || state.phase === "held";
      set({ phase: keep ? state.phase : "loading", error: keep ? state.error : "" });
      try {
        const summary = await input.client.loadSummary(input.bookingId, signal);
        set({ summary, phase: keep ? state.phase : "ready" });
      } catch (problem) { set({ phase: keep ? state.phase : "ready", error: plain(problem, "Your programme's schedule could not be loaded.") }); }
    },
    select(slot: RollingSlot | null) { if (state.hold) return; set({ slot, error: "", message: "" }); },
    /** Hold the selected server-offered slot. A slot not offered by the summary is refused on the screen. */
    async hold() {
      const slot = state.slot;
      if (!slot || state.hold || state.phase === "holding" || state.phase === "confirming") return;
      if (!state.summary?.availableSlots.some((offered) => offered.start === slot.start && offered.end === slot.end)) { set({ error: "Choose one of the slots your trainer offered." }); return; }
      set({ phase: "holding", error: "", message: "" });
      try {
        const result = await input.client.sendAction({ bookingId: input.bookingId, actorKind: "customer", action: "hold", idempotencyKey: this.holdKeyFor(slot), slots: [slot] });
        const holdId = typeof result.holdId === "string" && result.holdId ? result.holdId : null;
        if (!holdId) { set({ phase: "ready", error: "PawSpace did not hold that slot. Choose a slot and try again; nothing is booked." }); return; }
        set({ phase: "held", hold: { holdId, expiresAt: toMs(result.expiresAt), slot }, message: "" });
      } catch (problem) { set({ phase: "ready", error: plain(problem, "That slot could not be held. Nothing is booked.") }); }
    },
    /** Confirm the held slot with its own stable key. Ambiguous outcomes keep the hold and the key for the retry. */
    async confirm() {
      const hold = state.hold;
      if (!hold || state.phase === "confirming" || state.phase === "confirmed") return;
      if (this.holdExpired()) { holdKeys.delete(slotKey(hold.slot)); set({ phase: "ready", hold: null, error: "Your hold on that slot has expired. Check your programme schedule before choosing another slot." }); return; }
      set({ phase: "confirming", error: "", message: "" });
      try {
        const result = await input.client.sendAction({ bookingId: input.bookingId, actorKind: "customer", action: "confirm", idempotencyKey: this.confirmKeyFor(hold.holdId), holdId: hold.holdId });
        const sessionIds = Array.isArray(result.sessionIds) ? result.sessionIds.map(String) : [];
        const status = String(result.status ?? "");
        if (isConfirmedAnswer(result)) {
          set({ phase: "confirmed", confirmedSessionIds: sessionIds, hold: null, slot: null, message: `Appointment confirmed${status ? ` (${status.replaceAll("_", " ")})` : ""}.` });
        } else {
          set({ phase: "held", error: `PawSpace answered "${status || "no status"}" but did not verify the confirmation. Confirm the same hold again using the same key, or check your programme schedule.` });
        }
      } catch (problem) {
        const text = plain(problem, "");
        if (HOLD_GONE.test(text) || this.holdExpired()) { holdKeys.delete(slotKey(hold.slot)); set({ phase: "ready", hold: null, error: text || "Your hold on that slot is no longer valid. Check your programme schedule before choosing another slot." }); }
        else set({ phase: "held", error: `${text ? `${text} ` : ""}Your confirmation could not be verified: it may or may not have gone through. Confirm the same hold again; it uses the same key, so PawSpace will not book it twice.` });
      }
      // The summary is the authority on what is booked, whatever the answer was; the answer's words stay on screen.
      await this.load(undefined, true);
    },
    /** Back to choosing. A hold being abandoned (expired or not) is finished intent: its key is discarded so the same slot is never a replay of the old hold. */
    reset() { if (state.hold) holdKeys.delete(slotKey(state.hold.slot)); set({ phase: "ready", slot: null, hold: null, error: "", message: "", confirmedSessionIds: [] }); },
  };
}
export type RollingBooking = ReturnType<typeof createRollingBooking>;
