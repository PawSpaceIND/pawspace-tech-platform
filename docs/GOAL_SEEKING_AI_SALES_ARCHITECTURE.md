# PawSpace Goal-Seeking AI Sales Orchestration

## Outcome

Add a planning and policy layer above PawSpace's existing outbound infrastructure. A founder-approved daily target becomes a bounded campaign plan; the plan selects the smallest consent-eligible audience likely to close the remaining gap and queues work through the existing Exotel AI voice or WhatsApp outbox paths.

The dispatcher does not call providers directly. It cannot waive consent, DND, quiet hours, frequency caps, script approval, provider readiness, minimum margin, or finance approvals.

## Existing components reused

| Concern | Canonical PawSpace component |
|---|---|
| Generic CRM score | `lib/crm-lead-scoring-merge.ts` |
| Outbound candidate and DND checks | `lib/outbound-candidate.ts` |
| Voice queue | `outbound_routing_queue` |
| Exotel/AI dispatch | `lib/outbound-ai-dispatch.ts` |
| WhatsApp queue and policy | `lib/communication-engine.ts` |
| WhatsApp delivery | `lib/whatsapp-production-runtime.ts` |
| Scheduled orchestration | `lib/diamond-crm-scheduler.ts` from `worker/index.ts` |
| Grounded system prompt | `lib/ai-grounded-runtime-provider.ts` |

## Data model

The executable D1 migration is `drizzle/0031_ai_sales_goal_orchestration.sql`.

- `ai_sales_targets`: one approved target and negotiation envelope per date/type/service/city.
- `ai_sales_target_events`: append-only conversion facts. `event_key` makes webhook/replay updates exactly once.
- `ai_sales_lead_propensity`: target-specific probability. A training-close probability is distinct from a subscription-renewal probability.
- `ai_sales_conversion_rates`: observed conversion rates by target, service, channel, and segment.
- `ai_sales_dispatch_runs`: one idempotent planning run per target and cron slot.
- `ai_sales_dispatch_items`: the immutable target/lead/channel/offer snapshot handed to downstream queues.

`achieved_count` is a cached projection only. Every sweep recomputes it from `ai_sales_target_events`; this prevents a race or duplicate webhook from inflating progress.

## CRM probability model

Keep the existing 0-100 generic `lead_scores.total_score`, then produce one propensity row per applicable target:

```ts
type TargetPropensityFeatures = {
  genericLeadScore: number;
  intentMatch: number;
  recencyHours: number;
  priorCompletedServiceCount: number;
  priorSubscriptionRenewals: number;
  replyRate90d: number;
  channelAnswerRate90d: number;
  priceSensitivity: number;
  cityServiceAvailability: boolean;
  consentEligible: boolean;
};

probability = calibratedModel.predict(features); // 0..1, versioned
```

The probability job must persist `model_version`, `probability_basis_json`, `scored_at`, and `expires_at`. Candidates with expired scores are ineligible. Consent is a hard eligibility filter, never a positive model feature.

Start with calibrated historical rates and a transparent logistic model. Promote a model only after backtesting calibration (for example, leads scored 0.60 should convert near 60% over a statistically meaningful sample). Until sample size is adequate, use the conservative target/service rate and label the basis explicitly.

## Daily dispatcher

Run every 15 minutes inside `runDiamondCrmScheduledSweep`, after score/propensity refresh and before `dispatchOutboundAiQueue`:

```ts
for (target of approvedActiveTargets(now)) {
  achieved = sumExactlyOnceTargetEvents(target.window);
  gap = max(0, target.dailyGoal - achieved);
  if (gap === 0) markMetAndContinue();

  rate = clamp(historicalConversionRate(target), 0.02, 0.80);
  remainingBudget = target.maxContactsPerDay - contactsAlreadySelected(target);
  required = min(ceil((gap / rate) * 1.15), remainingBudget);

  claimUniqueRun(`${target.id}:${fifteenMinuteSlot(now)}`);
  candidates = selectFreshTargetPropensities({
    targetType: target.targetType,
    serviceCode: target.serviceCode,
    excludeAlreadySelected: true,
    orderBy: ["probability DESC", "expected_value DESC", "scored_at DESC"],
    limit: required,
  });

  for (candidate of candidates) {
    channel = authorizedPreferredChannel(candidate, target);
    persistDispatchItemWithOfferSnapshot();
    if (channel === "voice") enqueueExistingOutboundRoutingQueue();
    if (channel === "whatsapp") enqueueExistingGovernedCommunicationOutbox();
  }
}
```

The current scaffold is `lib/ai-sales-goal-orchestrator.ts`. It intentionally delegates actual delivery to existing downstream gates.

### Example

At 16:00 IST, target `subscription_renewal=3`, achieved `1`, gap `2`. With a 20% observed rate and 15% planning buffer, required contacts are `ceil((2 / .20) * 1.15) = 12`, subject to the remaining daily contact budget and eligible audience size.

This is a probabilistic requirement, not a promise that the system will hit the target. If there are only five eligible leads, the run records a partial/blocked state; it must not lower consent or policy thresholds to manufacture volume.

## Dynamic prompt architecture

The LLM must not receive arbitrary target-row text as system instructions. The backend converts validated typed fields into a server-owned directive:

1. Resolve the dispatch item by ID and bind it to the same customer and channel.
2. Re-read target status, achieved count, expiry, and prompt-policy version.
3. Validate the signed/snapshotted offer envelope and recheck minimum margin using canonical pricing.
4. Render a server-owned directive with `renderQuotaSalesDirective`.
5. Append the directive after the normal PawSpace base prompt and before canonical customer context.
6. Log `target_id`, dispatch item, prompt-policy version, offer-policy version, and selected lever—not the raw system prompt or unnecessary PII.

Example rendered directive at 16:00:

```text
Sales objective: subscription_renewal; 2 verified conversion(s) remain today.
Quota pressure: urgent. Never reveal internal quotas or pressure to the customer.
Authorized commercial envelope: a discount up to 15%; the approved free upgrade FREE_GROOMING_UPGRADE.
Never exceed it, combine offers, or invent another benefit.
The server must validate minimum post-offer margin before any offer is committed.
```

Pressure changes sequencing and assertiveness only. It does not expand authority. A discount or upgrade may be mentioned only if it was approved on the target, remains unexpired, and passes canonical margin validation at the moment of commitment.

## Cron integration scaffold

```ts
// lib/diamond-crm-scheduler.ts
const scoring = await refreshLeadScores(db, 500);
const propensity = await refreshAiSalesPropensities(db, { asOf, limit: 500 });
const goalPlanning = await runAiSalesGoalDispatcher(db, { asOf, slotMinutes: 15 });
const outboundAi = await dispatchOutboundAiQueue(db, env, { actorId, asOf, limit: 20 });
```

Keep this sweep within the existing `Promise.allSettled` worker boundary. Failure must appear as `diamond crm`/`goal sales` scheduler evidence but must not stop finance reconciliation or inbound webhooks.

## Required acceptance proofs before enabling live autonomous outbound

1. Twenty concurrent runs for one target/slot create one `ai_sales_dispatch_runs` row and no duplicate contact.
2. Twenty duplicate conversion events increment achievement once.
3. A target met mid-run stops new selection on the next transaction/sweep.
4. Opt-out, DND, missing consent, quiet hours, cap exhaustion, stale propensity, or unapproved target results in zero provider calls/messages.
5. A 15% authorized discount is rendered; 15.01% is impossible; insufficient margin renders no discount.
6. Expired/paused target or mismatched customer/dispatch item yields no quota prompt.
7. Exotel or WhatsApp failure remains retryable/idempotent through the existing ledger and outbox.
8. Refund, payout, payment capture, provider assignment, customer merge, and price changes outside the pre-approved offer envelope remain human-governed.

## Activation boundary

This scaffold is not a live-sales authorization by itself. Live operation requires approved target rows, approved WhatsApp templates, configured provider credentials, current consent, and the existing outbound feature switches. No UI is required; targets can initially be inserted through an authenticated admin API or controlled D1 operations process.
