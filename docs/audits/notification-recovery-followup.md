# Notification delivery and scope follow-up

Candidate parent: `205f17f6`. This continues the 95% readiness goal; it does not certify that threshold.

## Connected defects repaired

1. A customer inbox GET previously invoked a global sweep of bookings, booking events, food orders/events and refunds. The route now passes its already-authorized customer ID into all source queries. Empty explicit scopes are rejected. The scheduled caller omits that scope and retains global generation. This prevents a customer's inbox request from generating other customers' messages or doing platform-wide scanning.
2. Chat was listed in the adapter catalogue and supported by the generic configured message boundary, but omitted by the scheduled dispatcher. It now resolves the canonical customer phone and uses the configured chat adapter through the existing UAT bridge. This is the PawSpace bridge contract, **not proof of native LimeChat API compatibility**.
3. An adapter could appear configured in the database while runtime bindings, allowlist or consent gates refused dispatch. These responses formerly left a due row queued for immediate selection on every cron. They now consume bounded retry/backoff and eventually reach DLQ. No gate is relaxed and no refusal becomes delivery.

## Executed evidence

- **309 infrastructure tests passed**, zero failed/skipped, including all four service execution suites, concurrency/financial boundaries, webhook and notification recovery tests.
- **22 targeted communication tests passed**, including the new chat bridge scenarios; these overlap the infrastructure suite.
- **9 notification scope/contract tests passed**, including two completed customer journeys, simultaneous inbox reads, ownership checks, scoped generation and the retained global scheduler. These counts must not be added as unique coverage.
- Build and TypeScript passed. Diff whitespace check passed.
- The built Worker against persisted local D1 returned HTTP 200 for both probes: the seeded owner scanned its three bookings and received 13 notifications; an explicitly empty customer scope scanned zero bookings and returned zero notifications. Both sweeps reported success.
- The chat test uses a real loopback HTTP server implementing the configured bridge contract. Missing runtime settings caused retry with a future due time and zero network sends. After supplying local test settings, exactly one request was accepted; another scheduler pass sent nothing. A signed callback changed the message to delivered; callback replay was deduplicated.
- A refused allowlist produced no outbound requests through five attempts, ending in DLQ. Later configuration changes did not silently replay that terminal row.

The last full platform run remains the earlier **4,652-test pass at `205f17f6`**; it was not rerun for this follow-up. Current validation is the targeted and infrastructure coverage above plus the rebuilt Worker probes.

## Still open

The 13 historical demo chat DLQ records are preserved. They are not retroactively labelled delivered. Operator-controlled DLQ replay, real provider receipts, native adapter compatibility and staging delivery/recovery remain acceptance work. No third-party customer messages, real payments or payouts were sent in this follow-up. Deployment configuration and approved staging identities remain unavailable; all financial tests stayed sandboxed.
