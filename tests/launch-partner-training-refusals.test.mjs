/*
 * LP-N05, Dog Training half — executed against POST /api/training-sessions.
 *
 * The trainer workspace showed "Unable to update Training session" for every governed refusal: the
 * lifecycle threw a plain Response, and authError redacts an ungoverned client error into the route's
 * fallback sentence. A trainer who accepted a session Operations had cancelled, or who tried to close
 * a session before the mandatory Owner Handover, could not tell which of the two had happened.
 *
 * Neither rule changes here. What changes is that the reason survives the route.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  freshWorld, seedBooking, sessionCookie, routeCall, TRAINER, trainer,
} from "./helpers/training-lifecycle-harness.mjs";

const { materializeTrainingProgramme } = await import("../lib/training-programme.ts");
const { mutateTrainingSession } = await import("../lib/training-session-lifecycle.ts");
const sessionsRoute = await import("../app/api/training-sessions/route.ts");

async function programme() {
  const world = freshWorld();
  const booking = seedBooking(world, { id: "B-LP-N05", group: "G-LP-N05", sessions: 3 });
  const { sessions } = await materializeTrainingProgramme(world.db, { bookingId: booking.id, actorId: "uat" });
  return { world, sessions };
}

test("LP-N05 a cancelled Training session names its own state when the trainer taps Accept", async () => {
  const { world, sessions } = await programme();
  const session = sessions[0];
  const owner = await sessionCookie(world.db, "provider", TRAINER);

  world.sqlite.prepare("UPDATE training_sessions SET status='cancelled' WHERE id=?").run(session.id);
  const refused = await routeCall(sessionsRoute.POST, "POST", "/api/training-sessions",
    { body: { sessionId: session.id, action: "accept", idempotencyKey: "lp-n05-accept" }, cookie: owner });

  assert.equal(refused.status, 409, "the state rule itself is unchanged");
  assert.match(String(refused.body.error), /Training session cannot accept from cancelled/i);
  assert.notEqual(String(refused.body.error), "Unable to update Training session");
  assert.equal(refused.body.code, "training_session_state_conflict");
  assert.equal(refused.body.sessionStatus, "cancelled");
  assert.equal(world.sqlite.prepare("SELECT status FROM training_sessions WHERE id=?").get(session.id).status, "cancelled",
    "and a refused accept moved nothing");
});

test("LP-N05 closing a Training session without the Owner Handover says which evidence is missing", async () => {
  const { world, sessions } = await programme();
  const session = sessions[0];
  const owner = await sessionCookie(world.db, "provider", TRAINER);
  const act = (action, key, extra = {}) => mutateTrainingSession(world.db, {
    sessionId: session.id, action, actorId: trainer(session.provider_id), idempotencyKey: key, ...extra,
  });

  await act("accept", "lp-n05-a");
  await act("on_the_way", "lp-n05-b");
  await act("arrive", "lp-n05-c", { latitude: 12.9716, longitude: 77.5946 });
  await act("start", "lp-n05-d");

  const refused = await routeCall(sessionsRoute.POST, "POST", "/api/training-sessions",
    { body: { sessionId: session.id, action: "complete", idempotencyKey: "lp-n05-complete" }, cookie: owner });

  assert.equal(refused.status, 409, "the Owner Handover requirement itself is unchanged");
  assert.match(String(refused.body.error), /Owner Handover/i);
  assert.notEqual(String(refused.body.error), "Unable to update Training session");
  assert.equal(refused.body.code, "training_owner_handover_required");
  assert.equal(refused.body.requiredMinutes, 15);
  assert.equal(world.sqlite.prepare("SELECT status FROM training_sessions WHERE id=?").get(session.id).status, "in_session",
    "and the session is still open, so the trainer can do what the message asks");
});
