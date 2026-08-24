import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

/**
 * The T2 case register deliberately invokes each backing behavioural regression in a fresh Node
 * process. Every backing suite creates its own in-memory D1 database, so E2E100-T2-026..050 cannot
 * leak provider, booking, incident, proof or settlement rows into one another or into demo data.
 */
const cases = [
  ["E2E100-T2-026", "groomer application and activation", [["tests/provider-activation-readiness-closure.test.mjs", "a fully cleared application is eligible"]]],
  ["E2E100-T2-027", "trainer application, mandates and readiness", [["tests/provider-lifecycle-hardening.test.mjs", "category mandates are configurable"], ["tests/provider-activation-readiness-closure.test.mjs", "provider with real services and no outstanding modules is ready"]]],
  ["E2E100-T2-028", "host application, verification and discovery", [["tests/provider-lifecycle-hardening.test.mjs", "boarding discovery only ever returns live, active, verified hosts"]]],
  ["E2E100-T2-029", "sitter eligibility and explicit host selection", [["tests/scheduling-hardening.test.mjs", "boarding and pet_sitting without a chosen host"]]],
  ["E2E100-T2-030", "walker lifecycle from booking to Finance", [["tests/walking-taxi-ops-hardening.test.mjs", "full chain: walking-flow booking path"]]],
  ["E2E100-T2-031", "taxi driver/handler eligibility and replacement", [["tests/walking-taxi-ops-hardening.test.mjs", "taxi driver replacement re-attributes"]]],
  ["E2E100-T2-032", "rejected verification and incomplete onboarding", [["tests/provider-activation-readiness-closure.test.mjs", "rejected KYC check blocks activation"], ["tests/provider-activation-readiness-closure.test.mjs", "missing mandatory onboarding data blocks readiness"]]],
  ["E2E100-T2-033", "service eligibility at the offer boundary", [["tests/provider-operations-integrity.test.mjs", "offer creation enforces real booking"]]],
  ["E2E100-T2-034", "city and zone eligibility at booking and offer boundaries", [["tests/canonical-booking-city-zone-integrity.test.mjs", "city mismatch is refused"], ["tests/provider-operations-integrity.test.mjs", "offer creation enforces real booking"]]],
  ["E2E100-T2-035", "five-city and six-role isolation", [["tests/provider-operations-integrity.test.mjs", "all supported provider roles remain isolated"]]],
  ["E2E100-T2-036", "working hours, weekly roster and time-off", [["tests/scheduling-hardening.test.mjs", "roster windows are evaluated in IST"], ["tests/provider-identity-onboarding-closure.test.mjs", "unavailable provider is not offered by matching"]]],
  ["E2E100-T2-037", "capacity and overlapping booking prevention", [["tests/scheduling-hardening.test.mjs", "double-booking is impossible"], ["tests/provider-operations-integrity.test.mjs", "offer creation enforces real booking"]]],
  ["E2E100-T2-038", "auto-assignment ranking and deterministic choice", [["tests/scheduling-hardening.test.mjs", "auto-assign picks the highest-scoring eligible provider"]]],
  ["E2E100-T2-039", "no-eligible-provider escalation without assignment loss", [["tests/scheduling-hardening.test.mjs", "no eligible replacement RESTORES the original assignment"]]],
  ["E2E100-T2-040", "accept, decline, unavailable and no-response", [["tests/provider-operations-integrity.test.mjs", "decline is recoverable"], ["tests/walking-taxi-ops-hardening.test.mjs", "walking offer expiry, no_show recovery"]]],
  ["E2E100-T2-041", "reassignment with immutable actor history", [["tests/scheduling-hardening.test.mjs", "staff reassign excludes the current provider"]]],
  ["E2E100-T2-042", "replacement preserves canonical booking and payment", [["tests/walking-taxi-ops-hardening.test.mjs", "mid-programme replacement resets handover"], ["tests/training-session-lifecycle.test.mjs", "recovery preserves paid-session integrity"]]],
  ["E2E100-T2-043", "service start and provider ownership", [["tests/grooming-provider-journey-closure.test.mjs", "accept, start journey, arrive, and start service"], ["tests/grooming-provider-journey-closure.test.mjs", "another authenticated provider cannot list or mutate"]]],
  ["E2E100-T2-044", "before/after/private proof and failed scan security", [["tests/walking-taxi-ops-hardening.test.mjs", "walking proof cannot be scan-approved by its submitter"], ["tests/training-session-lifecycle.test.mjs", "requires attendance homework progress and exact-session secure media"]]],
  ["E2E100-T2-045", "completion and customer acknowledgement", [["tests/walking-taxi-ops-hardening.test.mjs", "full chain: walking-flow booking path"]]],
  ["E2E100-T2-046", "late arrival and no-show recovery", [["tests/walking-taxi-ops-hardening.test.mjs", "walking offer expiry, no_show recovery"]]],
  ["E2E100-T2-047", "incident/case escalation without automatic guilt", [["tests/walking-taxi-ops-hardening.test.mjs", "incidents cannot be self-acknowledged or self-resolved"]]],
  ["E2E100-T2-048", "commission versus hired-provider treatment", [["tests/people-partner-hardening.test.mjs", "workspace earnings reconcile with provider_payout_computations"]]],
  ["E2E100-T2-049", "incentives, disputes and settlement preparation", [["tests/incentive-hardening.test.mjs", "adjustments need a second pair of eyes"], ["tests/provider-operations-integrity.test.mjs", "approved entitlement produces one exact sandbox instruction"], ["tests/provider-operations-integrity.test.mjs", "failed settlement cannot report approved"]]],
  ["E2E100-T2-050", "achievement, Operations dashboard, reports and restricted views", [["tests/incentive-hardening.test.mjs", "cancelled one does not qualify"], ["tests/operations-overview.test.mjs", "every headline number is computed from the seeds"], ["tests/provider-identity-onboarding-closure.test.mjs", "workspace is resolved from identity, and is own-record-only"]]],
];

assert.equal(cases.length, 25);
assert.deepEqual(cases.map(([id]) => id), Array.from({ length: 25 }, (_, index) => `E2E100-T2-${String(index + 26).padStart(3, "0")}`));

for (const [id, objective, regressions] of cases) {
  test(`${id} — ${objective}`, () => {
    assert.ok(regressions.length > 0, `${id} must have behavioural coverage`);
    for (const [file, pattern] of regressions) {
      const childEnv = { ...process.env, E2E100_CASE_ID: id };
      // Node sets this marker for a runner child; inheriting it would make the deliberately isolated
      // case process think it was a recursive shard and skip every selected file.
      delete childEnv.NODE_TEST_CONTEXT;
      const run = spawnSync(process.execPath, ["--experimental-strip-types", "--test", `--test-name-pattern=${pattern}`, file], {
        cwd: process.cwd(), encoding: "utf8", env: childEnv, timeout: 60_000,
      });
      const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
      assert.equal(run.status, 0, `${id} failed ${file} / ${pattern}\n${output.slice(-6_000)}`);
      assert.match(output, /pass [1-9][0-9]*/, `${id} pattern selected no passing behavioural test: ${file} / ${pattern}`);
    }
  });
}
