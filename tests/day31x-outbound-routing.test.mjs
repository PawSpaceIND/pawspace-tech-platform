/*
 * Day-31 wave 12: the outbound routing policy - who the platform is allowed to call, and how.
 *
 * lib/outbound-routing-policy.ts decides whether a customer goes to a human dialler, to the AI
 * bot, is held, or is suppressed. lib/outbound-candidate.ts feeds it real customer state and
 * writes the result into the dispatch queue. Neither had a test importing it.
 *
 * The routing SCORE only decides who gets called first. The suppression checks decide whether
 * someone is called at all, and those are consent rules with a regulator behind them - so the
 * order in which they are applied matters as much as the rules themselves: a suppression that
 * sits behind a score threshold only protects the customers nobody wanted to call anyway.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__D31X_OUT_DB__", "__D31X_OUT_ENV__");

const policy = await import("../lib/outbound-routing-policy.ts");

const MARKETING = ["grooming_renewal", "fresh_lead", "dormant_lead", "reactivation", "cross_sell"];
const SERVICE = ["requested_callback", "payment_recovery", "subscription_renewal"];
const ALL = [...MARKETING, ...SERVICE, "no_action"];

/** The most attractive caller the policy could possibly see: top score, top intent, full consent. */
const irresistible = (over = {}) => ({
  lifecycleCode: "requested_callback", leadScore: 100, customerScore: 100, ltv: 500_000,
  marketingConsent: true, serviceConsent: true, optedOut: false, coolingUntil: null,
  phoneAvailable: true, nextBestService: "grooming", asOf: Date.now(), ...over,
});

test("an opt-out beats everything else the policy knows", async () => {
  /*
   * Suppression must not be something a high enough score can outrank. The input here is the
   * single most valuable customer the policy could be shown.
   */
  for (const lifecycleCode of ALL) {
    const decision = policy.decideOutboundRoute(irresistible({ lifecycleCode, optedOut: true }));
    assert.equal(decision.lane, "suppressed", `${lifecycleCode}: an opted-out customer must never be called`);
    assert.equal(decision.priorityScore, 0, "a suppressed customer has no priority at all");
    assert.deepEqual(decision.reasons, ["dnd_or_opt_out"], "and the refusal must name itself");
  }
});

test("no phone means no call, before anything else is considered", async () => {
  for (const lifecycleCode of ALL) {
    const decision = policy.decideOutboundRoute(irresistible({ lifecycleCode, phoneAvailable: false }));
    assert.equal(decision.lane, "suppressed", `${lifecycleCode}: there is nothing to dial`);
    assert.deepEqual(decision.reasons, ["missing_phone"]);
  }
});

test("marketing needs marketing consent; service contact does not", async () => {
  /*
   * The distinction that matters legally. A renewal offer is marketing and needs consent; a
   * payment-recovery call about money the customer already owes is service contact and does not.
   */
  for (const lifecycleCode of MARKETING) {
    assert.equal(
      policy.decideOutboundRoute(irresistible({ lifecycleCode, marketingConsent: false })).lane, "suppressed",
      `${lifecycleCode} is marketing and must not go out without consent`,
    );
    assert.deepEqual(
      policy.decideOutboundRoute(irresistible({ lifecycleCode, marketingConsent: false })).reasons,
      ["marketing_consent_missing"],
    );
  }
  for (const lifecycleCode of SERVICE) {
    assert.notEqual(
      policy.decideOutboundRoute(irresistible({ lifecycleCode, marketingConsent: false })).lane, "suppressed",
      `${lifecycleCode} is service contact and does not need marketing consent`,
    );
  }
});

test("a customer who switched service contact off is not called about service either", async () => {
  for (const lifecycleCode of SERVICE) {
    const decision = policy.decideOutboundRoute(irresistible({ lifecycleCode, serviceConsent: false }));
    assert.equal(decision.lane, "suppressed", `${lifecycleCode} must respect an explicit service-contact refusal`);
    assert.deepEqual(decision.reasons, ["service_contact_disabled"]);
  }
});

test("a cooling period holds while it is running, and releases the moment it expires", async () => {
  const now = Date.now();
  const during = policy.decideOutboundRoute(irresistible({ lifecycleCode: "fresh_lead", coolingUntil: now + 1, asOf: now }));
  assert.equal(during.lane, "suppressed");
  assert.deepEqual(during.reasons, ["cooling_period_active"]);

  assert.notEqual(
    policy.decideOutboundRoute(irresistible({ lifecycleCode: "fresh_lead", coolingUntil: now, asOf: now })).lane, "suppressed",
    "a cooling period that has reached its expiry is over",
  );
  assert.notEqual(
    policy.decideOutboundRoute(irresistible({ lifecycleCode: "fresh_lead", coolingUntil: null, asOf: now })).lane, "suppressed",
  );
});

test("suppression is checked before routing, so a perfect score cannot bypass it", async () => {
  /*
   * Ordering, asserted directly. Each suppression reason is applied to the highest-scoring
   * possible input; if any of them sat behind the score branches, one of these would come back
   * as "human".
   */
  const suppressors = [
    ["missing phone", { phoneAvailable: false }],
    ["opted out", { optedOut: true }],
    ["cooling period", { lifecycleCode: "fresh_lead", coolingUntil: Date.now() + 60_000 }],
    ["no marketing consent", { lifecycleCode: "fresh_lead", marketingConsent: false }],
    ["service contact off", { lifecycleCode: "payment_recovery", serviceConsent: false }],
  ];
  for (const [label, over] of suppressors) {
    const decision = policy.decideOutboundRoute(irresistible(over));
    assert.equal(decision.lane, "suppressed", `${label} must suppress even the best-scoring caller`);
    assert.equal(decision.priorityScore, 0);
  }
});

test("a consented, high-intent customer reaches a human and a low-value one does not", async () => {
  const human = policy.decideOutboundRoute(irresistible({ lifecycleCode: "requested_callback" }));
  assert.equal(human.lane, "human", "someone who asked for a callback gets a person");
  assert.equal(human.highIntent, true);
  assert.ok(human.priorityScore >= 80);

  const held = policy.decideOutboundRoute(irresistible({
    lifecycleCode: "no_action", leadScore: 0, customerScore: 0, ltv: 0, nextBestService: null,
  }));
  assert.equal(held.lane, "hold", "nobody is called just because they exist");
  assert.deepEqual(held.reasons, ["below_outbound_threshold"]);
});

test("the mid-band goes to the AI bot rather than a person", async () => {
  const ai = policy.decideOutboundRoute(irresistible({
    lifecycleCode: "dormant_lead", leadScore: 45, customerScore: 40, ltv: 0, nextBestService: null,
  }));
  assert.equal(ai.lane, "ai");
  assert.ok(ai.priorityScore >= 30 && ai.priorityScore < 80, `mid-band score, got ${ai.priorityScore}`);
});

test("the priority score is always a score", async () => {
  for (const bad of [Number.NaN, Infinity, -Infinity, -500, 10_000]) {
    for (const field of ["leadScore", "customerScore"]) {
      const decision = policy.decideOutboundRoute(irresistible({
        lifecycleCode: "no_action", ltv: 0, nextBestService: null, leadScore: 0, customerScore: 0, [field]: bad,
      }));
      assert.ok(decision.priorityScore >= 0 && decision.priorityScore <= 100,
        `${field}=${bad} must clamp, got ${decision.priorityScore}`);
      assert.ok(Number.isInteger(decision.priorityScore));
    }
  }
});

test("every decision carries the policy version that made it", async () => {
  for (const lifecycleCode of ALL) {
    assert.equal(policy.decideOutboundRoute(irresistible({ lifecycleCode })).policyVersion, policy.OUTBOUND_POLICY_VERSION,
      "a routing decision must be attributable to a policy version");
  }
  assert.ok(policy.OUTBOUND_POLICY_VERSION.length > 0);
});

test("the marketing/service split is exported once and agrees with the routing it drives", async () => {
  for (const lifecycleCode of MARKETING) {
    assert.equal(policy.isMarketingLifecycle(lifecycleCode), true, `${lifecycleCode} is marketing`);
  }
  for (const lifecycleCode of [...SERVICE, "no_action"]) {
    assert.equal(policy.isMarketingLifecycle(lifecycleCode), false, `${lifecycleCode} is not marketing`);
  }
  /*
   * lib/outbound-candidate.ts only applies a cooling period when isMarketingLifecycle() says so,
   * so that predicate and the consent branch inside the policy must agree about the same set -
   * a drift between them would suppress the wrong lifecycles.
   */
  for (const lifecycleCode of ALL) {
    const withoutMarketingConsent = policy.decideOutboundRoute(irresistible({ lifecycleCode, marketingConsent: false }));
    assert.equal(
      withoutMarketingConsent.reasons[0] === "marketing_consent_missing",
      policy.isMarketingLifecycle(lifecycleCode),
      `${lifecycleCode}: the exported predicate and the consent branch must classify it the same way`,
    );
  }
});
