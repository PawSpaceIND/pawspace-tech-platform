/*
 * Day-31 wave 2: the AI runtime kill switch.
 *
 * setAiKillSwitch (the Ops console write) -> resolveExplicitAiKillSwitches (the runtime read).
 *
 * This is the control someone reaches for at the worst possible moment: the assistant is saying
 * something it should not, to real customers, and a human needs it to stop NOW. A kill switch that
 * silently fails to match is worse than having none at all, because the operator believes the AI
 * has been stopped and goes back to sleep.
 *
 * So the property here is not "a kill switch can stop the AI" - it is "a kill switch an operator
 * could plausibly type stops the AI", which is a much larger set of inputs than the happy path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world } from "./helpers/execution-harness.mjs";

installWorkersHooks("__D31W_KILL_DB__", "__D31W_KILL_ENV__");

const OPS = "founder@pawspace.in";
const LIVE_CALL = { channel: "whatsapp", intent: "booking_create", provider: "workers_ai", model: "llama-3.3-70b" };

async function seedKill() {
  const { sqlite, db } = world("__D31W_KILL_DB__", "__D31W_KILL_ENV__");
  const config = await import("../lib/ai-business-configuration.ts");
  await config.ensureAiBusinessConfiguration(db);
  const { resolveExplicitAiKillSwitches } = await import("../lib/ai-runtime-kill-switch.ts");
  return { sqlite, db, config, resolveExplicitAiKillSwitches };
}

const flip = (config, db, scopeType, scopeKey, disabled = true) => config.setAiKillSwitch(db, {
  scopeType, scopeKey, disabled, reason: "Day-31: assistant is misbehaving, stop it", actorEmail: OPS,
});

test("nothing is killed when no switch is set", async () => {
  const { db, resolveExplicitAiKillSwitches } = await seedKill();
  assert.deepEqual(await resolveExplicitAiKillSwitches(db, LIVE_CALL), []);
});

test("each scope stops exactly the traffic it names", async () => {
  for (const [scopeType, scopeKey] of [
    ["global", "ai"], ["channel", "whatsapp"], ["intent", "booking_create"],
    ["provider", "workers_ai"], ["model", "llama-3.3-70b"],
  ]) {
    const { db, config, resolveExplicitAiKillSwitches } = await seedKill();
    await flip(config, db, scopeType, scopeKey);
    const hits = await resolveExplicitAiKillSwitches(db, LIVE_CALL);
    assert.equal(hits.length, 1, `${scopeType}:${scopeKey} must stop this call`);
    assert.equal(hits[0].scopeType, scopeType);
    assert.ok(hits[0].reason.length > 0, "a kill must carry the reason an operator gave");
  }
});

test("a switch that does not name this traffic leaves it running", async () => {
  const { db, config, resolveExplicitAiKillSwitches } = await seedKill();
  await flip(config, db, "channel", "voice");
  await flip(config, db, "intent", "refund_review");
  assert.deepEqual(await resolveExplicitAiKillSwitches(db, LIVE_CALL), [],
    "killing voice must not take web chat down with it");
});

test("re-enabling actually re-enables", async () => {
  const { db, config, resolveExplicitAiKillSwitches } = await seedKill();
  await flip(config, db, "channel", "whatsapp");
  assert.equal((await resolveExplicitAiKillSwitches(db, LIVE_CALL)).length, 1);
  await flip(config, db, "channel", "whatsapp", false);
  assert.deepEqual(await resolveExplicitAiKillSwitches(db, LIVE_CALL), [],
    "a switch turned back on must not keep blocking");
});

test("a kill switch an operator could plausibly type still stops the AI", async () => {
  /*
   * THE CASE THAT MATTERS. setAiKillSwitch trims the scope key but does not case-fold it, and the
   * runtime matched with ===. An operator stopping WhatsApp under pressure types "WhatsApp",
   * because that is how the product spells it everywhere in the UI - and the runtime passes
   * "whatsapp". The row is written, the console shows the switch as engaged, the audit log records
   * it, and the assistant keeps talking to customers.
   */
  for (const typed of ["WhatsApp", "WHATSAPP", " whatsapp ", "Whatsapp"]) {
    const { db, config, resolveExplicitAiKillSwitches } = await seedKill();
    await flip(config, db, "channel", typed);
    const hits = await resolveExplicitAiKillSwitches(db, LIVE_CALL);
    assert.equal(hits.length, 1, `a channel switch written as "${typed}" must stop channel "whatsapp"`);
  }
  for (const typed of ["Booking_Create", " booking_create"]) {
    const { db, config, resolveExplicitAiKillSwitches } = await seedKill();
    await flip(config, db, "intent", typed);
    assert.equal((await resolveExplicitAiKillSwitches(db, LIVE_CALL)).length, 1,
      `an intent switch written as "${typed}" must stop intent "booking_create"`);
  }
  for (const typed of ["Workers_AI", "WORKERS_AI"]) {
    const { db, config, resolveExplicitAiKillSwitches } = await seedKill();
    await flip(config, db, "provider", typed);
    assert.equal((await resolveExplicitAiKillSwitches(db, LIVE_CALL)).length, 1,
      `a provider switch written as "${typed}" must stop provider "workers_ai"`);
  }
});

test("the runtime's own casing cannot slip past a correctly written switch either", async () => {
  const { db, config, resolveExplicitAiKillSwitches } = await seedKill();
  await flip(config, db, "channel", "whatsapp");
  for (const runtimeChannel of ["WhatsApp", "WHATSAPP", " whatsapp"]) {
    assert.equal(
      (await resolveExplicitAiKillSwitches(db, { ...LIVE_CALL, channel: runtimeChannel })).length, 1,
      `a call arriving as "${runtimeChannel}" must still be stopped`,
    );
  }
});

test("a GLOBAL switch stops everything, whatever key it was filed under", async () => {
  /*
   * The resolver required scope_key to be exactly "ai" for a global kill. An operator setting a
   * global switch has already said "global" in the scope type; filing it as "global", "all" or
   * "AI" produced a row that matched nothing at all - the most dangerous possible outcome for the
   * one control that is supposed to stop every channel at once.
   */
  for (const key of ["ai", "AI", "global", "all", "*"]) {
    const { db, config, resolveExplicitAiKillSwitches } = await seedKill();
    await flip(config, db, "global", key);
    const hits = await resolveExplicitAiKillSwitches(db, LIVE_CALL);
    assert.equal(hits.length, 1, `a global kill filed as "${key}" must stop the AI`);
    assert.equal(hits[0].scopeType, "global");

    const otherTraffic = await resolveExplicitAiKillSwitches(db, { channel: "voice", intent: "support", provider: "openai", model: "gpt" });
    assert.equal(otherTraffic.length, 1, `a global kill filed as "${key}" must stop every other channel too`);
  }
});

test("every switch that applies is reported, so the operator sees the full picture", async () => {
  const { db, config, resolveExplicitAiKillSwitches } = await seedKill();
  await flip(config, db, "channel", "whatsapp");
  await flip(config, db, "intent", "booking_create");
  const hits = await resolveExplicitAiKillSwitches(db, LIVE_CALL);
  assert.equal(hits.length, 2, "both reasons matter when working out what to re-enable");
  assert.deepEqual(hits.map((h) => h.scopeType).sort(), ["channel", "intent"]);
});

test("a switch cannot be engaged without a reason on the record", async () => {
  const { db, config } = await seedKill();
  await assert.rejects(
    () => config.setAiKillSwitch(db, { scopeType: "channel", scopeKey: "whatsapp", disabled: true, reason: "x", actorEmail: OPS }),
    Error,
    "stopping the assistant is an event that needs an explanation attached",
  );
  await assert.rejects(
    () => config.setAiKillSwitch(db, { scopeType: "channel", scopeKey: "  ", disabled: true, reason: "Day-31 no key given", actorEmail: OPS }),
    Error,
    "a switch with no scope key would silently protect nothing",
  );
});
