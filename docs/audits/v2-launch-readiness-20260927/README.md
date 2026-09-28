# PawSpace V2: launch-readiness audit and resilience repair

**Audit date:** 27 September 2026 (Asia/Kolkata).  
**Release decision: NO-GO for an unrestricted public launch.** This is a tested repair batch, not a claim of universal device compatibility or completed release certification. Production credentials, domains, live payments, publishing and production deployment were excluded from this task and were not changed.

## 1. Exact scope and reference versions

The isolated repair branch is `fix/v2-launch-offline-readiness-20260927`, based on main `3432e5ce9eb6b015789e1325ea7a01a7048d3bb8`. `app/v2/partner/page.tsx` directly mounts the shared partner-app implementation repaired here, so these are V2 runtime fixes, not a separate demonstration app.

At the audit read, V2 PR #1143 remained open at `4525715b7652115a3f9702f74eda9191459111df` and documented unresolved acceptance gaps. PRs #1138, #1140 and #1142 carried independent service, UI and Founder-access work. This branch does not replace their composed staging candidate, merge their work, or deploy main over staging. A final release must test one exact integrated candidate containing all accepted fixes.

Historical protocol references inspected:

- `docs/LAUNCH_AUDIT_REPORT.md`: its historical readiness statement concerned isolated human UAT; it is not evidence that the current V2 build is ready for public launch.
- `docs/qa-evidence/performance-audit-2026-09-27/README.md`: existing targeted performance work, with remaining field/device/load qualification. Its results are not silently inherited by a newer candidate.
- Existing browser, persona, pre-UAT, privacy, supply-chain, concurrency, restore-drill and performance workflow definitions were inventoried. A workflow file existing is not proof that its latest run passed against this release.
- `lib/types/provider-offline-sync.ts` defines `ProviderDayCache`; no implemented day-cache consumer was found. An interface claiming encryption is not implemented offline storage.

The shared historical regression suite was run. This is not an independent re-certification of every separately shipped V1 binary or every V1 physical-device combination.

## 2. Implemented repairs

| Failure found | Repair implemented | Evidence |
|---|---|---|
| A timed request ignored the caller's cancellation | Forward caller/Request abort signals; pre-cancelled requests never dispatch; cancellation is not mislabeled as a timeout | Executed network regressions |
| Headers arrived but the JSON body could stall indefinitely in status replay | Add a shared JSON deadline covering headers, body and parsing; use it in partner status replay | Stalled success and error-body tests |
| Temporary gateway errors or broken JSON could turn a saved status into a permanent failure | Classify HTTP 408, 425, 429 and 5xx as retryable; retain interrupted responses for reconciliation | HTTP and malformed-body regressions |
| Retries ignored server backoff guidance | Persist retry count/deadline; use exponential backoff with jitter and honor Retry-After | Stable original event/checklist and deadline tests |
| A photo was reported saved before IndexedDB committed | Resolve only on transaction completion; reject abort/quota failures | Fake-transaction fault tests plus real-browser abort-after-put test |
| WebKit test contexts rejected persisted Blob records | Store ArrayBuffer bytes and reconstruct Blob on dispatch; continue reading legacy Blob records | Three-engine real IndexedDB tests |
| Stale upload callbacks could operate on old queue objects/session state | Re-read under the queue lock; check session generation before/after sending and before retry serialization | Stale-record, logout/serialization and completion race tests |
| Offline queue reporting said zero pending when photos remained | Read committed queue entries and report the real offline pending count | Offline pending-count test |
| HTTP 401 could discard an unsynced photo as a permanent error | Preserve it as recoverable pending work; retain permanent ownership/type refusal behavior | Expired-auth and refusal classification tests |
| Returning to a suspended page did not explicitly trigger replay | Add pageshow and visible-page resume triggers, retaining online and interval replay | Shared V2 partner page/hook wiring and rendered-screen tests |
| A database rollback test failed before reaching its intended fault | Use current local fixture schemas and a valid synthetic governed booking; require the exact injected error and a successful positive control after fault removal | Real local D1 rollback test |
| A role test used staff headers without declaring its simulated trusted ingress | Declare trust only in the local proof-worker configuration; add a test-environment guard | Real local D1 denied/allowed persistence test; production auth unchanged |

The original status event ID, checklist, provider-ownership validation and current-state reconciliation are preserved. No offline cash confirmation, payout, refund, invoice or payment-capture authority was added. No production authentication rule was relaxed. Existing UI byte snapshots were refreshed only for the reviewed runtime files; unrelated hashes and interaction/AST assertions remain enforced.

## 3. Executed verification and its limits

See `evidence.json` for machine-readable counts, log digests and tested runtime-file hashes.

- **Full unit/integration sweep:** 8,451 tests executed, 8,449 passed and two existing local-D1 fixture tests failed. Both failures were diagnosed and repaired. Both subsequently passed separately and in the 77-test delivery regression run. **The whole 8,451-test sweep was not rerun after these test-only fixture repairs.** Do not relabel the earlier run as an all-green full sweep.
- **Delivery regression run:** 77/77 passed, including offline transport/storage, authorization-sensitive partner proof wiring and both repaired real-D1 tests.
- **UI/source-contract verification:** 67/67 passed. These checks overlap the full sweep and must not be added to it as new unique test coverage.
- **Browser matrix:** the initial expanded matrix passed 165/165 with zero retries. It covers V2 navigation, grooming checkout/recovery, real queue storage, and existing all-route appearance/accessibility checks. **The separate actual partner-screen matrix passed 14/14. Total: 179 browser cases passed across two disjoint runs, with zero retries.** Their independent results and test-method limits are recorded in `evidence.json`.
- **Type checking and build:** passed. The production-format Worker/hosting artifact was built and verified locally; it was not deployed.
- **Changed-file lint:** no errors. Existing hook/unused-type/anonymous-export warnings remain; a passing exit code does not mean zero warnings.

### Browser/device matrix

The core scenarios run in Chromium, Firefox and WebKit desktop profiles; a 360-pixel Android profile; a 390-pixel iPhone profile; a 320-pixel narrow profile; and a 768-pixel tablet profile. The all-route visual suite sets its own desktop/mobile and light/dark appearance variants. Firefox and WebKit also execute an all-V2-route layout pass. These are automated browser profiles, **not physical Android/iPhone certification**, not all OS/browser versions, and not native-app certification.

The actual partner tests exercise `/v2/partner`, its real React handlers, real localStorage/IndexedDB, real selected file bytes and automatic replay. Booking/identity responses remain synthetic local fixtures. Photo size and SHA-256 are checked against the real intercepted request bytes in Chromium/Firefox. WebKit sends its bytes to a loopback HTTP receiver for the same checks, because its request inspector omits Blob bodies. This is stronger than merely counting an upload callback, but is not a real object-store/virus-scan/Ops-approval integration test.

### Important WebKit test limitations

A minimal standalone reproduction showed that Playwright WebKit `context.setOffline(true)` causes even a locally created `new Blob(["synthetic"]).text()` and local FileReader reads to fail with NotReadableError. It succeeds online, without PawSpace code involved. The WebKit photo test therefore uses real API-transport failures plus navigator/online-offline events, while preserving real file-input reads. Chromium and Firefox use full browser offline emulation. This distinction is not hidden as a physical-airplane-mode pass.

WebKit's intercepted `request.postDataBuffer()` also omitted the Blob upload body. Instead of weakening the byte assertion, the WebKit test verifies the bytes at an actual loopback HTTP receiver. The browser still executes the real upload request. Chromium/Firefox keep same-origin intercepted receipts: rewriting their request to a different loopback origin introduces unrelated browser transport restrictions into this fixture.

### Offline behavior actually covered

An already-loaded eligible grooming job can save its checked status update or selected proof photo locally, then replay when connectivity returns or the page resumes. Queue storage survives reload. A lost status response is reconciled with current ownership/state before retrying, and the same event identity is reused. Photos are not acknowledged as saved before durable storage commits.

This does **not** prove that the entire app can cold-start without internet, that every partner edit is queued, that unsynced work survives an explicit sign-out/device-storage clearing, or that a killed browser uploads in the background. A reload test with API failures but reachable application assets is not an offline cold-start test.

## 4. Release protocol and remaining acceptance gates

Status meanings: PASS = executed within the stated fixture scope; PARTIAL = some evidence, broader qualification open; GAP = known implementation or integration gap; NOT RUN = no fresh evidence from this audit. None of the open rows is silently waived because production setup was excluded.

| ID | Release condition | Status | Required closure evidence |
|---|---|---|---|
| L01 | One integrated release candidate | GAP | Merge/reconcile approved parallel changes in dependency order; rerun gates against that exact SHA and staging artifact |
| L02 | Browser engines and responsive layout | PARTIAL | Automated profiles pass; qualify declared minimum OS/browser versions, Android WebView, Samsung/in-app browsers and physical devices |
| L03 | Small screens, rotation, keyboard, large text and safe areas | PARTIAL | Automated narrow layouts exist; run physical landscape, dynamic keyboard, 200% text/zoom, notch/dock and gesture-navigation checks |
| L04 | Weak, intermittent and absent internet | PARTIAL | Current fault classes tested; add bandwidth/latency/loss, captive portal, DNS/TLS failure, network handover and long-disconnection scenarios |
| L05 | Durable status/proof outbox and replay | PASS, scoped | Current local/browser tests pass; repeat against real staging endpoints and capture durable server receipts |
| L06 | Offline cold start and assigned-day data | GAP | Implement reviewed encrypted, expiry-limited day cache; show stale/read-only state; no invented new assignment while disconnected |
| L07 | All promised partner details work offline | GAP | Inventory notes, checklists, incident details and service-specific actions; implement a provider-scoped outbox and tested conflict policy for each allowed action |
| L08 | Session expiry, sign-out and account/device switching | PARTIAL | Scoped race tests pass; verify complete multi-tab/device handoff and an explicit warning/recovery policy for unsynced work before sign-out |
| L09 | Mobile suspension and killed-app recovery | NOT RUN | Physical iOS/Android background, force-kill, reboot and update tests; distinguish browser foreground resume from native background jobs |
| L10 | Low storage, eviction, private mode and corrupt data | PARTIAL | Transaction abort tested; qualify queue capacity, eviction, cache migration, persistent-storage policy and recoverable user messaging |
| L11 | Large or interrupted media uploads | GAP | Size/data-saver policy, image downsampling, resumable upload/receipt checks, server scan/approval and cancellation/resume tests |
| L12 | Every service from booking through accounts | PARTIAL | Execute all service/payment/partner/CRM/ledger/GST paths on the integrated candidate; grooming fixture checks are not proof for every vertical |
| L13 | Payment failure, duplicate callbacks and return-to-app | PARTIAL | Existing regression and V2 grooming return checks pass; qualify real sandbox success/failure/retry/webhook/reconciliation across all services |
| L14 | Role/Founder/provider/customer permissions | PARTIAL | Regression and local D1 permission tests pass; verify current auth PRs, expired sessions, privilege changes and cross-user isolation on the candidate |
| L15 | Speed and real-user responsiveness | NOT RUN, fresh field evidence | Measure LCP/INP/CLS on real devices and weak links; compare warm/cold routes and p50/p95 API latency to agreed budgets |
| L16 | Peak concurrency, soak and reconnect storms | NOT RUN | Load bookings, polling, simultaneous replay, contention and memory/DB limits without duplicate work or delayed payment truth |
| L17 | GPS, map, ETA and permissions | PARTIAL | Existing source behavior retained; qualify denied/approximate/stale GPS, navigation handoff and background limitations on real devices |
| L18 | Accessibility | PARTIAL | Automated contrast/reduced-motion/navigation checks pass; manual keyboard, VoiceOver/TalkBack, focus, announcements and error-recovery review remains |
| L19 | Security and dependency assurance | PARTIAL | Existing security regressions pass; review OWASP ASVS scope, dependency/SBOM/secrets results and independent attack testing for the candidate |
| L20 | Local privacy and retention | GAP | Review encryption/key handling, shared-device exposure, retention/erasure, log redaction and cached customer data before offline day-cache rollout |
| L21 | Upgrade and rollback compatibility | NOT RUN | Queue/data migrations with pending work, old/new API compatibility, interrupted app update and rollback without losing events |
| L22 | Backup/restore and reconciliation | NOT RUN, fresh candidate | Execute restore into isolated scratch infrastructure; prove booking/payment/media identities and recovery checkpoints survive |
| L23 | Observability and operations recovery | PARTIAL | Define queue age/failure/auth-expiry metrics and escalation; prove alerts, correlation IDs, recovery playbooks and kill-switch behavior without hiding failed work |
| L24 | Native distribution and platform restrictions | NOT RUN | Signed build installation/upgrade, battery-saver/permission/notification checks and store-policy qualification; production account setup remains excluded |
| L25 | AI and external providers | NOT RUN, end-to-end in this batch | Actual configured sandbox adapters, outages, timeouts, safe fallback and human escalation; no live phone calls or paid side effects here |
| L26 | Localization, dates and input formats | PARTIAL | Existing regressions only; qualify supported languages, fonts, long translations, timezone/currency/phone/address entry and assistive input |

### Proposed performance acceptance standard

For supported real-user populations, measure the 75th percentile of LCP <= 2.5 seconds, INP <= 200 milliseconds and CLS <= 0.1, separated by mobile/desktop. These are Core Web Vitals thresholds, not measurements achieved by this branch. Add explicit business API/error/queue-age budgets agreed before the load run. Test low-end devices and poor links rather than extrapolating from a fast development laptop.

### Correctness rules that must not be compromised for offline convenience

Never treat locally queued work as server-confirmed completion. Never authorize a provider from cached identity alone. Never let stale GPS prove arrival. Never convert a failed request into an empty successful roster, zero earnings or a captured payment. Never silently discard a refused photo without the required operator/user recovery policy. Refetch assignment and server state before replay; stop for a conflict requiring human resolution.

## 5. Repeatable gate

`playwright.launch-readiness.config.ts` and `.github/workflows/v2-launch-resilience.yml` add a repeatable seven-profile/three-engine regression gate, with separate all-route visual coverage, sandbox-only execution and retained CI artifacts. The workflow is a new proposed gate; branch-protection enforcement and a passing remote run are not implied by adding the file.

```sh
npm ci --no-audit --no-fund
node node_modules/@playwright/test/cli.js install --with-deps chromium firefox webkit
npm run typecheck
npm run build
PW_PORT=4291 PAWSPACE_PAYMENT_ENV=sandbox PAWSPACE_PAYMENT_LIVE_APPROVED=false FORBID_PRODUCTION=true APP_ENV=staging node node_modules/@playwright/test/cli.js test --config playwright.launch-readiness.config.ts
```

The full-suite command used was `node --experimental-strip-types --test --test-concurrency=1 tests/*.test.mjs` with the repository's local-preview, service-discovery, voice-simulator, sandbox and test environment flags. It includes real local D1 proof workers, not production databases.

## 6. Next closure order

First integrate the accepted auth/UI/service fixes without overwriting the existing staged composite. Next close secure offline cold-start/day caching, the complete action outbox and unsynced-work recovery policy. Then run physical-device and real-sandbox media/payment/service journeys. Finally run performance/load/soak, security, accessibility, upgrade and recovery gates against the same release SHA. Public launch remains blocked until required rows have actual evidence or an explicit documented product-scope decision.

No percentage score is assigned: one unresolved payment, authorization or data-loss gate can invalidate an otherwise high average.

## External standards and platform references

- Core Web Vitals thresholds and lab/field distinction: https://web.dev/articles/vitals
- Background Synchronization availability and secure-context limitations: https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API
- OWASP Application Security Verification Standard: https://owasp.org/www-project-application-security-verification-standard/
- WCAG 2.2 target-size minimum guidance: https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html

These inform the proposed release criteria; this document does not claim access to Uber's internal launch checklist.
