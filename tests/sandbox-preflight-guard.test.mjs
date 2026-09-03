import test from "node:test";
import assert from "node:assert/strict";

/*
 * The sandbox preflight harness judging itself.
 *
 * tests/integration/ deliberately sits outside the blocking Release CI glob so a third-party sandbox
 * outage can never turn CI red - which also means nothing in CI would notice if the harness's own
 * logic broke. These are the two decisions it makes that must not rot, and neither needs a network or
 * a credential, so they belong here in the blocking suite rather than beside the suites they gate.
 *
 * Both cases came out of review on the PR that introduced the harness:
 *
 *   1. The probe timeout was `Number(process.env.PAWSPACE_SANDBOX_PROBE_TIMEOUT_MS || 12_000)`, so a
 *      malformed value ("soon", "-1") became NaN or non-positive, setTimeout fired immediately, every
 *      probe aborted, and every healthy sandbox was reported endpoint_unreachable. Misreporting a
 *      working endpoint as broken is the one diagnosis this harness exists to get right.
 *   2. Variables only SOME tests need were listed as suite-wide `required`, so an environment holding
 *      the API keys but not an inbound webhook secret skipped the outbound tests too.
 */

const preflightModule = () => import("./integration/sandbox-preflight.mjs");

test("guard: a malformed probe timeout can never abort a probe instantly", async () => {
  const { __probeTimeoutMs } = await preflightModule();
  // Each of these produced NaN or a non-positive delay, and setTimeout treats both as "fire now".
  for (const raw of ["soon", "", " ", "0", "-1", "NaN", "1e-9", undefined, null]) {
    const resolved = __probeTimeoutMs(raw);
    assert.ok(Number.isFinite(resolved) && resolved >= 1_000,
      `a timeout of ${JSON.stringify(raw)} resolved to ${resolved}, which would abort the probe before the request could answer`);
  }
});

test("guard: a usable probe timeout is honoured, and an absurd one is bounded", async () => {
  const { __probeTimeoutMs } = await preflightModule();
  assert.equal(__probeTimeoutMs("20000"), 20_000, "a sensible override is used as given");
  assert.equal(__probeTimeoutMs("500"), 1_000, "below the floor is raised to the floor, not accepted");
  assert.equal(__probeTimeoutMs("999999"), 60_000, "above the ceiling is capped, so one probe cannot hang a run");
});

test("guard: a missing REQUIRED variable stops the suite; a missing OPTIONAL one stops only its own tests", async () => {
  const { preflight } = await preflightModule();
  const ABSENT = "PAWSPACE_SANDBOX_GUARD_ABSENT_VAR";
  assert.equal(process.env[ABSENT], undefined, "the fixture depends on this name being unset");

  // No probe, so this makes no network call.
  const partial = await preflight({ suite: "guard: partial credentials", required: [{ name: "PATH" }], optional: [{ name: ABSENT }] });
  assert.equal(partial.ready, true, "the suite is ready when everything REQUIRED is present");
  assert.deepEqual(partial.gate(), {}, "so its ordinary tests run");
  assert.deepEqual(partial.gateOn("PATH"), {}, "and a test needing a present variable runs");
  assert.match(partial.gateOn(ABSENT).skip ?? "", /credentials_absent/,
    "while a test needing the absent one skips, naming why");
  assert.match(partial.diagnostics, new RegExp(ABSENT), "and the diagnostic block reports the partial state");

  const blocked = await preflight({ suite: "guard: no credentials", required: [{ name: ABSENT }] });
  assert.equal(blocked.ready, false, "a missing REQUIRED variable is not ready");
  assert.match(blocked.gate().skip ?? "", /credentials_absent/, "and every test in the suite skips");
});

test("guard: no secret VALUE can reach the diagnostics", async () => {
  const { fingerprint, preflight } = await preflightModule();
  const NAME = "PAWSPACE_SANDBOX_GUARD_SECRET";
  const value = "sk_live_this_must_never_be_printed";
  process.env[NAME] = value;
  try {
    const state = await preflight({ suite: "guard: fingerprint only", required: [{ name: NAME }] });
    assert.ok(!state.diagnostics.includes(value), "the diagnostic block must never contain the secret itself");
    const print = fingerprint(NAME);
    assert.match(print, /^[0-9a-f]{8}$/, "a fingerprint is 8 hex characters");
    assert.ok(!value.includes(print) || print.length === 8, "and is a digest, not a slice of the value");
    assert.ok(state.diagnostics.includes(print), "which is what identifies the loaded credential instead");
  } finally {
    delete process.env[NAME];
  }
});
