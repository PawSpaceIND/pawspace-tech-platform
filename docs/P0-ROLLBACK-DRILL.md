# P0 Rollback & Disaster Recovery Certification

Scope: 1% pilot release candidates only. The drill MUST run against an isolated release-preview Worker and scratch/isolated D1. It MUST NOT roll back production or shared staging.

## Preconditions

- Record candidate `RELEASE_SHA`, current release-preview Worker version, D1 database id, schema migration level, and queue/outbox counts.
- Confirm `PAWSPACE_PAYMENT_ENV=sandbox`, communications/voice test controls, and UAT-only identities.
- Confirm a known-good previous Worker version exists before rollback.

## Gate A — D1 backward compatibility

1. Create a D1 backup from the candidate database.
2. Restore the backup into a newly created scratch database.
3. Run `tests/d1-restore-scratch-guard.test.mjs` and the repository migration/restore guards against the scratch database.
4. Verify core reads for customer, booking, payment, provider work order, invoice and communication outbox survive the restore.
5. Record migration level and row-count invariants. Any destructive/unreadable schema change blocks rollback.

## Gate B — kill switches

Run `tests/ai-enablement.test.mjs` and assert the global safety stop disables AI staff answers/actions. Verify provider/communication test controls remain fail-closed when required configuration is absent. A rollback must never re-enable a disabled high-impact capability merely because an older application version is running.

## Gate C — queue/event replay

Run `tests/customer-reminder-lifecycle-runtime.test.mjs` and `tests/communication-enqueue-contract-runtime.test.mjs`. Capture queue/outbox counts before replay, replay the same governed events, and prove idempotency keys prevent duplicate durable work while failed deliveries remain retryable/dead-letterable.

## Gate D — application rollback rehearsal

On the isolated release-preview Worker only:

1. Deploy candidate SHA and verify `/healthz` reports the candidate `RELEASE_SHA`.
2. Execute one synthetic lifecycle and record its booking/payment/event ids.
3. Switch the Worker to the recorded previous known-good version using Cloudflare version/deployment tooling.
4. Verify `/healthz` and record rollback recovery time.
5. Re-read the synthetic booking/payment/work-order created before rollback and verify the older application can read the persisted shape.
6. Replay the recorded queue/webhook event and assert no duplicate payment, booking, notification or work order is created.
7. Re-deploy the candidate version and verify health and persisted state again.

## Acceptance criteria

- Scratch restore succeeds and all restore guards pass.
- Previous application version can read candidate-written core records.
- Kill switches remain effective before, during and after rollback.
- Replayed queues/webhooks are idempotent.
- No production/shared-staging resource is mutated.
- Recovery time and evidence artifact are recorded.
- Any missing prior Worker version, destructive schema incompatibility, duplicate replay, or failed health check is a P0 release block.
