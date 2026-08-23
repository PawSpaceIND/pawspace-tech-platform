import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// The call lifecycle, executed as a graph rather than asserted from source text.
//
// Before this module existed a call had four statuses written by direct UPDATEs, so the ledger could
// describe a sequence that cannot physically happen - a completed call later marked failed, a blocked
// call that then dialled, a call connected without a policy check. An audit trail that can contain
// impossible histories is not evidence of anything.
//
// Every pair of states is enumerated here. A pair in the adjacency list must be permitted; EVERY other
// pair - 27 x 27 of them minus the legal ones - must throw. That is the assertion the mission's "do not
// allow impossible state transitions" actually needs: not that some illegal transitions are refused,
// but that nothing outside the declared graph is reachable.
// ---------------------------------------------------------------------------

const machine = await import("../lib/voice-call-state.ts");
const { VOICE_CALL_STATES, VOICE_CALL_TRANSITIONS, assertVoiceCallTransition, canVoiceCallTransition,
        VOICE_BLOCKED_STATES, VOICE_TERMINAL_STATES, VOICE_RETRYABLE_STATES, voiceFailureReasonClass } = machine;

test("the lifecycle the mission specifies exists, end to end", () => {
  const happyPath = ["requested", "policy_check", "queued", "dialing", "ringing", "connected", "speaking", "listening", "handoff_requested", "completed", "ended"];
  for (const state of happyPath) assert.ok(VOICE_CALL_STATES.includes(state), `${state} is a declared state`);
  // requested -> policy_check -> queued -> dialing -> ringing -> connected
  const spine = ["requested", "policy_check", "queued", "dialing", "ringing", "connected"];
  for (let i = 0; i + 1 < spine.length; i++) assert.ok(canVoiceCallTransition(spine[i], spine[i + 1]), `${spine[i]} -> ${spine[i + 1]}`);
  // connected -> speaking/listening, and either -> completed or -> handoff_requested
  for (const turn of ["speaking", "listening"]) {
    assert.ok(canVoiceCallTransition("connected", turn));
    assert.ok(canVoiceCallTransition(turn, "completed"));
    assert.ok(canVoiceCallTransition(turn, "handoff_requested"));
  }
  assert.ok(canVoiceCallTransition("completed", "ended"));
});

test("every failure state the mission names is a real state with a reason class", () => {
  const required = ["blocked_consent", "blocked_quiet_hours", "provider_unavailable", "dial_failed", "no_answer", "busy", "stt_failed", "tts_failed", "ai_handoff", "provider_error", "cancelled"];
  for (const state of required) {
    assert.ok(VOICE_CALL_STATES.includes(state), `${state} exists`);
    assert.ok(voiceFailureReasonClass(state), `${state} reports a failure reason class`);
  }
});

test("NO transition outside the declared graph is possible, exhaustively", () => {
  let illegal = 0, legal = 0;
  for (const from of VOICE_CALL_STATES) {
    for (const to of VOICE_CALL_STATES) {
      const declared = VOICE_CALL_TRANSITIONS[from].includes(to);
      if (declared) { legal++; assert.deepEqual(assertVoiceCallTransition(from, to), { from, to }); continue; }
      illegal++;
      assert.throws(() => assertVoiceCallTransition(from, to), /Illegal voice call transition/, `${from} -> ${to} must be refused`);
    }
  }
  // Guards the assertion itself: if the graph were emptied or opened up, these floors fail rather than
  // the suite quietly proving nothing.
  assert.ok(legal >= 60, `expected a real graph, got ${legal} legal transitions`);
  assert.ok(illegal > 600, `expected the vast majority of pairs to be illegal, got ${illegal}`);
  assert.equal(legal + illegal, VOICE_CALL_STATES.length ** 2);
});

test("a state cannot transition to itself, so a redelivered event cannot re-apply", () => {
  for (const state of VOICE_CALL_STATES) assert.throws(() => assertVoiceCallTransition(state, state), /Illegal voice call transition/);
});

test("a policy refusal is terminal and reachable ONLY from policy_check", () => {
  assert.ok(VOICE_BLOCKED_STATES.length >= 8, "each refusal reason is its own state");
  for (const blocked of VOICE_BLOCKED_STATES) {
    assert.deepEqual(VOICE_CALL_TRANSITIONS[blocked], [], `${blocked} is terminal`);
    const sources = VOICE_CALL_STATES.filter(state => VOICE_CALL_TRANSITIONS[state].includes(blocked));
    assert.deepEqual(sources, ["policy_check"], `${blocked} must be reachable only from policy_check, got ${sources.join(",")}`);
  }
});

test("a refused call can never reach a dialling state, at any depth", () => {
  // Walk the whole graph from each blocked state. Nothing may be reachable at all - which is what makes
  // "blocked in the ledger" proof that no dial happened.
  for (const blocked of VOICE_BLOCKED_STATES) {
    const seen = new Set(), queue = [blocked];
    while (queue.length) {
      const state = queue.pop();
      for (const next of VOICE_CALL_TRANSITIONS[state]) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    assert.deepEqual([...seen], [], `${blocked} must reach nothing`);
  }
});

test("every state is reachable from requested, so no state is dead code", () => {
  const seen = new Set(["requested"]), queue = ["requested"];
  while (queue.length) {
    const state = queue.pop();
    for (const next of VOICE_CALL_TRANSITIONS[state]) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  }
  const unreachable = VOICE_CALL_STATES.filter(state => !seen.has(state));
  assert.deepEqual(unreachable, [], `unreachable states: ${unreachable.join(", ")}`);
});

test("only transient faults are retryable - a policy decision never is", () => {
  assert.deepEqual([...VOICE_RETRYABLE_STATES].sort(), ["busy", "dial_failed", "no_answer", "provider_error", "provider_unavailable"]);
  for (const blocked of VOICE_BLOCKED_STATES) assert.ok(!VOICE_RETRYABLE_STATES.includes(blocked), `${blocked} must not be retryable`);
  // Retrying a consent or quiet-hours refusal would be dialling someone the policy just protected.
  assert.ok(!VOICE_RETRYABLE_STATES.includes("blocked_consent"));
  assert.ok(!VOICE_RETRYABLE_STATES.includes("blocked_quiet_hours"));
  assert.ok(!VOICE_RETRYABLE_STATES.includes("blocked_opt_out"));
});

test("a speech-stack failure keeps the human handoff route open", () => {
  for (const state of ["stt_failed", "tts_failed"]) {
    assert.ok(canVoiceCallTransition(state, "handoff_requested"), `${state} -> handoff_requested`);
    assert.ok(canVoiceCallTransition(state, "ended"));
    assert.ok(!canVoiceCallTransition(state, "connected"), "a failed speech stack does not silently resume");
  }
});

test("a handoff cannot turn back into the bot talking", () => {
  assert.deepEqual([...VOICE_CALL_TRANSITIONS.handoff_requested].sort(), ["ai_handoff", "completed", "provider_error"]);
  for (const turn of ["speaking", "listening", "connected"]) assert.ok(!canVoiceCallTransition("handoff_requested", turn));
});

test("terminal states are exactly ended plus every refusal", () => {
  assert.deepEqual([...VOICE_TERMINAL_STATES].sort(), ["ended", ...VOICE_BLOCKED_STATES].sort());
});

test("an unknown state is refused rather than treated as new", () => {
  assert.throws(() => assertVoiceCallTransition("connected", "hung_up"), /Unknown voice call state/);
  assert.throws(() => assertVoiceCallTransition("", "ended"), /Unknown voice call state/);
  assert.throws(() => assertVoiceCallTransition("connected", null), /Unknown voice call state/);
  assert.equal(canVoiceCallTransition("connected", "hung_up"), false);
});
