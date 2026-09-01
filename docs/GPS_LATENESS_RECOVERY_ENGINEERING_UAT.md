# Universal GPS, ETA, lateness and recovery engineering UAT

Status: **ENGINEERING UAT CANDIDATE / STAFF + DEVICE UAT PENDING**

**PRODUCTION READY = FALSE.** This workstream does not authorize production location tracking, live customer messaging, provider deductions, live payouts, or public launch.

## Engineering gates

1. Universal booking/provider location sessions use canonical booking/provider ownership and approved service policy.
2. GPS evidence preserves client capture time and independent server receive time, with explicit accepted/stale/low-accuracy trust states.
3. ETA snapshots reference exact origin evidence, use the existing sandbox Google Routes adapter, carry freshness/degraded state and remain forecasts rather than guaranteed arrival.
4. Predicted-late events use versioned policy thresholds and an idempotency key; missing/stale/untrusted evidence cannot become confirmed lateness.
5. Recovery cases are opened before accountability. Replacement search rechecks service, zone, availability, collision, daily capacity and commission-provider acceptance requirements.
6. Accountability is a separate human-review workflow. GPS/ETA/performance signals cannot directly create settlement or payroll deductions.
7. Financial adjustment creation requires an approved accountability case plus `finance.manage`, is one-per-case/idempotent, and does not transmit live money.
8. Policy and controls remain configurable. Pet Taxi is **within active GPS UAT scope**: `/api/location-recovery` accepts a `pet_taxi` punctuality policy and reports its telemetry as `deterministic_sandbox`. This scope was widened by PR #388; the exclusion previously recorded here no longer matches the API. Sandbox telemetry is not production GPS - `lib/taxi-proof-governance.ts` continues to report `productionGpsConnected: false`, and **PRODUCTION READY = FALSE** above still governs. Production map mode is rejected by the UAT API.
9. Privacy and safety controls include least-privilege raw GPS access, configurable raw-GPS retention, explicit GPS/map kill switches, sandbox-only map transport and audit events.

## Required staff/device UAT

Use real test identities and a deployed exact candidate. Verify provider ownership denial, tracking outside booking state, invalid/stale/low-accuracy GPS, map configuration-required/provider failure, ETA staleness, scheduled-time changes, duplicate runner behavior, recovery with and without an eligible replacement, commission-provider acceptance, insufficient evidence, rejected/exempted/disputed accountability cases, approved adjustment idempotency/reversal path, period handling, kill switches and least-privilege raw location access.

Do not infer success from CI. Preserve canonical booking/session/location/ETA/punctuality/recovery/accountability/adjustment IDs plus actor, policy version and audit references. Do not place uncontrolled raw GPS histories or sensitive customer addresses in GitHub evidence.

## Production blockers intentionally open

Approved GPS/privacy/retention policy; production Maps credentials and controlled verification; provider-device trust/anti-spoof design; approved service-by-service applicability; approved lateness/recovery/accountability policy; Partner Finance production treatment; production customer messaging; monitoring/alerting; security/privacy review; real-device UAT; performance/reliability evidence; and controlled Bengaluru pilot.

Passing exact-head CI means **engineering-ready for staff/device UAT**, not production-ready.
