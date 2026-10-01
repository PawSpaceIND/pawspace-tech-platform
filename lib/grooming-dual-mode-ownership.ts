import type { GoalAutonomyMode } from "./goal-context-engine";
import type { WhatsAppConversationMode } from "./whatsapp-conversation-control";

/** Opt-in foundation only. No routes, DDL, runtime flags or canonical handlers are changed. */
export type OwnershipMode = "atlas_led" | "employee_led";
export type WorkBoundary = "generation" | "tool_commit" | "discretionary_send";
export type JourneyPhase = "lead" | "quoted" | "reserved" | "pending_payment" | "booked";
export type Ownership = Readonly<{
  threadId: string; leadId: string; customerId: string; serviceCode: "grooming";
  version: number; mode: OwnershipMode; employeeId: string | null;
  phase: JourneyPhase; bookingId: string | null; orderId: string | null;
  termsVersion: number; confirmedTermsVersion: number | null;
}>;

/** Resolved by existing controls, never supplied by the customer/model. Revision must change
 * on EVERY control change, including off/on cycles, and participate in the atomic commit. */
export type EffectiveControls = Readonly<{
  revision: string; goalMode: GoalAutonomyMode; verticalEnabled: boolean;
  customerAiAllowed: boolean; staffAiAllowed: boolean; modelEnabled: boolean; handoffPaused: boolean;
  whatsappMode: WhatsAppConversationMode | null;
}>;
export type Actor = Readonly<{ kind: "ai" | "employee"; id: string }>;
export type WorkTicket = Readonly<{
  threadId: string; leadId: string; customerId: string; version: number;
  controlsRevision: string; actor: Actor;
}>;
export class OwnershipConflict extends Error {}

export function assertOwnership(state: Ownership): void {
  if (state.serviceCode !== "grooming" || !state.threadId || !state.leadId || !state.customerId ||
      !Number.isSafeInteger(state.version) || state.version < 0 ||
      !Number.isSafeInteger(state.termsVersion) || state.termsVersion < 0 ||
      !["lead", "quoted", "reserved", "pending_payment", "booked"].includes(state.phase) ||
      !["atlas_led", "employee_led"].includes(state.mode) ||
      (state.mode === "employee_led" ? !state.employeeId : state.employeeId !== null) ||
      (state.confirmedTermsVersion !== null && state.confirmedTermsVersion !== state.termsVersion) ||
      (["reserved", "pending_payment", "booked"].includes(state.phase) && !state.bookingId) ||
      (["pending_payment", "booked"].includes(state.phase) && !state.orderId)) {
    throw new OwnershipConflict("Invalid canonical Grooming ownership state");
  }
}

export function effectiveOwnership(state: Ownership, controls: EffectiveControls) {
  assertOwnership(state);
  const aiAllowed = state.mode === "atlas_led" && !controls.handoffPaused &&
    controls.verticalEnabled && controls.modelEnabled && controls.customerAiAllowed &&
    (controls.whatsappMode === null || controls.whatsappMode === "ai_assistant");
  return { mode: state.mode, employeeId: state.employeeId, aiAllowed,
    aiMayCommit: aiAllowed && controls.goalMode === "execute_within_envelope" };
}

/** This is an additional gate; consent, role, scope, finance approval and confirmation
 * remain enforced by the SAME canonical handlers for either actor. */
export function assertWorkBoundary(state: Ownership, controls: EffectiveControls,
  ticket: WorkTicket, boundary: WorkBoundary): void {
  assertOwnership(state);
  if (!controls.revision || ticket.threadId !== state.threadId || ticket.leadId !== state.leadId ||
      ticket.customerId !== state.customerId || ticket.version !== state.version ||
      ticket.controlsRevision !== controls.revision) {
    throw new OwnershipConflict("Stale ownership or controls; discard work and refresh");
  }
  if (ticket.actor.kind === "employee") {
    if (state.mode !== "employee_led" || state.employeeId !== ticket.actor.id) {
      throw new OwnershipConflict("Employee is not the effective owner");
    }
    if (boundary === "generation" && (!controls.modelEnabled || !controls.staffAiAllowed || !controls.verticalEnabled)) {
      throw new OwnershipConflict("Internal AI assistance is disabled");
    }
    return; // Employees can continue with every model/AI switch off.
  }
  const effective = effectiveOwnership(state, controls);
  if (!effective.aiAllowed || (boundary !== "generation" && !effective.aiMayCommit)) {
    throw new OwnershipConflict("Existing AI controls require employee continuation");
  }
}

export function issueWorkTicket(state: Ownership, controls: EffectiveControls, actor: Actor,
  boundary: WorkBoundary): WorkTicket {
  const ticket = Object.freeze({ threadId: state.threadId, leadId: state.leadId,
    customerId: state.customerId, version: state.version,
    controlsRevision: controls.revision, actor: Object.freeze({ ...actor }) });
  assertWorkBoundary(state, controls, ticket, boundary);
  return ticket;
}

/** Invoke under the existing authorized handoff CAS transaction. Even same-mode transitions
 * advance the epoch: AI -> employee -> AI must never revive old work. */
export function transitionOwnership(state: Ownership, expectedVersion: number,
  mode: OwnershipMode, employeeId: string | null): Ownership {
  assertOwnership(state);
  if (state.version !== expectedVersion || state.version === Number.MAX_SAFE_INTEGER) {
    throw new OwnershipConflict("Ownership changed concurrently");
  }
  const next = Object.freeze({ ...state, mode, employeeId, version: state.version + 1 });
  assertOwnership(next);
  return next;
}

/** Canonical quote/reprice handler calls this inside its guarded transaction. Identity,
 * reservation and order remain canonical; a changed quote cannot inherit old consent. */
export function advanceTerms(state: Ownership): Ownership {
  assertOwnership(state);
  if (state.termsVersion === Number.MAX_SAFE_INTEGER || state.version === Number.MAX_SAFE_INTEGER) {
    throw new OwnershipConflict("Version exhausted");
  }
  return Object.freeze({ ...state, version: state.version + 1,
    termsVersion: state.termsVersion + 1, confirmedTermsVersion: null });
}

export function assertFreshConfirmation(state: Ownership, confirmedTermsVersion: number): void {
  assertOwnership(state);
  if (confirmedTermsVersion !== state.termsVersion || state.confirmedTermsVersion !== state.termsVersion) {
    throw new OwnershipConflict("Current canonical terms require fresh customer confirmation");
  }
}

export type SendAttempt = Readonly<{ key: string; status: "claimed" | "sent" | "uncertain" | "not_sent" }>;
/** Outbox key excludes actor/mode/version; takeover cannot manufacture a second send.
 * Intent ID is a persisted canonical ID, never regenerated when ownership changes. */
export function canonicalSendKey(state: Ownership, intentId: string): string {
  assertOwnership(state);
  if (!intentId.trim()) throw new OwnershipConflict("Canonical message intent ID required");
  return JSON.stringify(["grooming", state.threadId, intentId]);
}
export function assertSendCanBeClaimed(attempt: SendAttempt | null): void {
  if (attempt && attempt.status !== "not_sent") {
    throw new OwnershipConflict("Existing send must be reconciled; do not resend");
  }
}

export interface OwnershipReadPort {
  read(threadId: string): Promise<{ state: Ownership; controls: EffectiveControls }>;
}
/** Local source contract for the eventual D1 adapter. This operation MUST atomically read
 * controls + owner, assertWorkBoundary, and commit canonical mutation/outbox claim under
 * the same transaction/CAS. A preflight check followed by an unguarded handler is invalid. */
export interface OwnershipCommitPort extends OwnershipReadPort {
  commit(ticket: WorkTicket, boundary: "tool_commit" | "discretionary_send",
    canonicalCommandId: string): Promise<unknown>;
}
/** Employee generation produces an INTERNAL suggestion; it never acquires AI send/commit rights. */
export async function generateOwnedReply<T>(port: OwnershipReadPort, ticket: WorkTicket,
  generate: () => Promise<T>): Promise<T> {
  const before = await port.read(ticket.threadId);
  assertWorkBoundary(before.state, before.controls, ticket, "generation");
  const reply = await generate();
  const after = await port.read(ticket.threadId);
  assertWorkBoundary(after.state, after.controls, ticket, "generation");
  return reply;
}
