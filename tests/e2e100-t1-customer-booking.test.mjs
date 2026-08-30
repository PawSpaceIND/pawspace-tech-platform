import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const job = (file, pattern) => ({ file, pattern });

// Each objective runs its owning behavioural regression in a fresh Node process. Those suites invoke
// the real route/module against their own in-memory SQLite-backed D1 adapter, so every case is isolated
// and repeatable even when this file is executed as part of the repository-wide test glob.
const cases = [
  ["E2E100-T1-001", "registration, OTP/session and canonical returning-customer binding", [
    job("tests/customer-registration-profile-integrity.test.mjs", "concurrent OTP registrations|registration, returning login"),
    job("tests/comms-identity-hardening.test.mjs", "OTP: expiry|OTP double-consume race|assertion: replay"),
  ]],
  ["E2E100-T1-002", "name, phones, email, saved address and city round-trip", [
    job("tests/customer-registration-profile-integrity.test.mjs", "registration, returning login, profile and address"),
  ]],
  ["E2E100-T1-003", "pet creation, typed attributes, idempotency and ownership", [
    job("tests/pet-manager.test.mjs", "adding a pet persists|edit-in-place updates|cannot edit another customer's pet|replaying the same idempotency|server-side validation"),
  ]],
  ["E2E100-T1-004", "verified, pending, missing and invalid vaccination truth", [
    job("tests/boarding-reservation-authority.test.mjs", "owned, verified pet|unverified pet|pending vaccination|does not exist"),
    job("tests/pet-manager.test.mjs", "server-side validation rejects bad pet profiles"),
  ]],
  ["E2E100-T1-005", "Bengaluru, Mumbai, Pune, Hyderabad and Chennai identities", [
    job("tests/customer-registration-profile-integrity.test.mjs", "all five UAT city identities"),
    job("tests/city-propagation-closure.test.mjs", "all customer booking flows propagate resolved city"),
  ]],
  ["E2E100-T1-006", "city, zone and PIN serviceability", [
    job("tests/service-zone-coverage.test.mjs", "core Bengaluru area|advertised coverage|explicit reviewed database mapping"),
    job("tests/canonical-booking-city-zone-integrity.test.mjs", "city and zone match the reservation"),
  ]],
  ["E2E100-T1-007", "cross-city and unsupported-zone refusal with zero orphan writes", [
    job("tests/grooming-golden-journey.test.mjs", "second-city journey|unsupported location"),
    job("tests/canonical-booking-city-zone-integrity.test.mjs", "city mismatch|zone mismatch|mismatched city/zone is refused"),
  ]],
  ["E2E100-T1-008", "canonical Grooming booking", [
    job("tests/grooming-golden-journey.test.mjs", "Bengaluru customer completes one canonical discounted Grooming booking"),
  ]],
  ["E2E100-T1-009", "Training plan and session booking", [
    job("tests/training-hardening.test.mjs", "dog_training booking materializes exactly N sessions|programme whose every session completes"),
  ]],
  ["E2E100-T1-010", "Boarding reservation, host choice and stay lifecycle", [
    job("tests/scheduling-hardening.test.mjs", "boarding with a chosen host reserves"),
    job("tests/stay-lifecycle-hardening.test.mjs", "awaiting_host_acceptance -> accept"),
  ]],
  ["E2E100-T1-011", "Sitting implemented visit/overnight products and unsupported daycare refusal", [
    job("tests/customer-registration-profile-integrity.test.mjs", "implemented Sitting visit and overnight packages"),
    job("tests/stay-split-payments.test.mjs", "createSittingQuote with split_50_50"),
  ]],
  ["E2E100-T1-012", "recurring Walking plan booking and completion", [
    job("tests/walking-flow.test.mjs", "recurring quote shaped exactly|reserveWalkingSchedule sends"),
    job("tests/walking-taxi-ops-hardening.test.mjs", "full chain: walking-flow booking path"),
  ]],
  ["E2E100-T1-013", "Taxi route, distance/fare inputs, driver assignment and no-driver state", [
    job("tests/taxi-flow.test.mjs", "quote shaped exactly|server enforces the constraints|reserveTaxiSchedule sends|fails loudly with no driver"),
  ]],
  ["E2E100-T1-014", "Food order and repeat subscription", [
    job("tests/food-hardening.test.mjs", "order derives everything|order -> accept|renewal generates a payment LINK|full chain: quoteFoodCart"),
  ]],
  ["E2E100-T1-015", "date/slot validation, duplicate submission and simultaneous collision", [
    job("tests/scheduling-hardening.test.mjs", "double-booking is impossible|replaying the same clientRequestId"),
    job("tests/food-hardening.test.mjs", "concurrent double-submit"),
    job("tests/grooming-stack-hardening.test.mjs", "overlapping reservation blocks"),
  ]],
  ["E2E100-T1-016", "provider preference and no-provider condition", [
    job("tests/scheduling-hardening.test.mjs", "preferredProviderId is a soft|without a chosen host return"),
    job("tests/grooming-golden-journey.test.mjs", "no-capacity failures|provider unavailability"),
  ]],
  ["E2E100-T1-017", "deterministic canonical auto-assignment", [
    job("tests/scheduling-hardening.test.mjs", "auto-assign picks the highest-scoring|auto-assign services pick the highest-scoring"),
  ]],
  ["E2E100-T1-018", "full payment, verified authority, tamper and cross-customer refusal", [
    job("tests/money-hardening.test.mjs", "webhook refuses unsigned|verify-first|capture amount mismatch"),
    job("tests/payment-order-cross-customer-runtime.test.mjs", "cannot open a payment order for another customer's booking"),
    job("tests/live-payment-integrity.test.mjs", "full-payment booking creates a gateway order"),
  ]],
  ["E2E100-T1-019", "split payment and exact accumulated collection", [
    job("tests/split-payment-capture-settlement.test.mjs", "capturing the balance settles|both instalments accumulate|re-sent FIRST instalment"),
    job("tests/stay-lifecycle-hardening.test.mjs", "unpaid 50/50 balance blocks"),
  ]],
  ["E2E100-T1-020", "post-service payment-link contract without live-money claims", [
    job("tests/post-service-payment-link.test.mjs", "creates a bound, non-partial Razorpay sandbox link|preserves network failure|refuses missing credentials"),
  ]],
  ["E2E100-T1-021", "coupon eligibility, expiry, reuse, stacking boundary and service mismatch", [
    job("tests/grooming-pricing-coupon-runtime.test.mjs", "validity, scope, threshold and redemption limits|preserves governed amount and rejects tampered totals"),
    job("tests/money-hardening.test.mjs", "coupon quote->consume|concurrent consumes"),
  ]],
  ["E2E100-T1-022", "Grooming subscription reservation, consumption and reversal", [
    job("tests/grooming-stack-hardening.test.mjs", "subscription credits reserve|completing a service settles reserved credits|cancellation releases reserved subscription credits"),
  ]],
  ["E2E100-T1-023", "reschedule and date-change collision controls", [
    job("tests/grooming-stack-hardening.test.mjs", "reschedule reservation move is atomic|reschedule and cancel are server-priced"),
    job("tests/training-hardening.test.mjs", "staff reschedule is rejected|reschedule inside roster still rejects"),
  ]],
  ["E2E100-T1-024", "cancellation, partial/full refund and refund ceiling", [
    job("tests/grooming-golden-journey.test.mjs", "captured booking cancellation"),
    job("tests/training-hardening.test.mjs", "cancellation refund math is exact|refund math deducts"),
    job("tests/refund-cap-collected-funds.test.mjs", "booking total is not the refund ceiling"),
  ]],
  ["E2E100-T1-025", "completion proof, invoice, CRM, loyalty, review and reminder consequences", [
    job("tests/cross-module-journey-gate.test.mjs", "journey: grooming from lead to reports"),
    job("tests/grooming-stack-hardening.test.mjs", "booking -> accept -> travel -> proof -> complete"),
    job("tests/incentive-hardening.test.mjs", "PawPoints earn once"),
    job("tests/misc-verticals-hardening.test.mjs", "review submission is owner-only|review sweep only chases completed"),
    job("tests/customer-reminder-lifecycle-runtime.test.mjs", "completed grooming booking past the cadence|cancelled past booking"),
    job("tests/crm-conversion-integrity-runtime.test.mjs", "captured payment converts|CANCELLED booking|REFUNDED booking"),
  ]],
];

function runBehaviour({ file, pattern }) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [
    "--experimental-strip-types",
    "--test",
    "--test-name-pattern",
    pattern,
    file,
  ], { cwd: process.cwd(), env, encoding: "utf8", timeout: 120_000 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const plainOutput = output.replace(/\x1B\[[0-9;]*m/g, "");
  assert.equal(result.error, undefined, `${file} could not execute: ${result.error?.message ?? "unknown error"}`);
  assert.equal(result.status, 0, `${file} failed for /${pattern}/\n${output.slice(-8_000)}`);
  // Node 22 renders the TAP aggregate as `ℹ pass N`; Node 24 emits `# pass N`.
  // Require a non-zero aggregate under either valid renderer so a fully skipped
  // name pattern can never make an objective appear exercised.
  assert.match(plainOutput, /(?:^|\n)(?:ℹ|#) pass [1-9]\d*(?:\r?\n|$)/m, `${file} pattern /${pattern}/ did not execute any matching behaviour`);
}

for (const [id, objective, jobs] of cases) {
  test(`${id} — ${objective}`, { timeout: 300_000 }, () => {
    assert.match(id, /^E2E100-T1-0(?:0[1-9]|1\d|2[0-5])$/);
    for (const item of jobs) runBehaviour(item);
  });
}
