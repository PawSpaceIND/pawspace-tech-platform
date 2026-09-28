# PR #1144 — CodeQL failure recovery

Date: 27 September 2026. Original PR head: `16ba6be96e350dc6fc0cfcee4b284f2a92fc28b8`.

## Verified failure

All Actions workflows had completed successfully, including the original V2 compatibility workflow, when this recovery started. The separate CodeQL result check failed on high-severity alert **228**, rule `js/cors-misconfiguration-for-credentials`, at `e2e/v2-partner-offline-app.spec.ts:14`.

The local synthetic upload receiver reflected any incoming Origin (or `*`) and enabled credentialed cross-origin access. The finding is in a test receiver, not the production media API, but it is fixed rather than dismissed or excluded from scanning.

## Change

The receiver derives exactly one allowed origin from Playwright's configured local application URL. Non-loopback origins and URLs containing credentials are refused before the receiver starts. Incoming requests must match the configured origin and upload path. Only PUT and its constrained preflight are allowed. Credentialed CORS is removed, allowed headers are an explicit fixed list, and unsupported origins/preflights are refused before any photo bytes are accepted. No application/runtime, production configuration, permission rule or scan policy changed.

## Executed verification

- **21/21 partner browser cases passed**, across the same seven Chromium/Firefox/WebKit and device profiles, with zero retries, failures or skipped cases.
- These include the existing offline status/photo journeys and seven instances of the new receiver security regression: foreign, opaque (`null`), wildcard, lookalike, wrong-port and absent origins are denied; unsupported preflight methods/headers are denied; the configured-origin preflight and exact-byte upload still succeed without credentialed CORS.
- Type checking passed. Targeted lint passed with no errors or warnings. A separate local V2 browser smoke rendered its expected navigation.
- The original remote Web-test job had also completed successfully: **8,441 tracked tests and 10 supplemental tests**, each group with zero failures or skips. This is historical evidence for the original head, not a claim that the new head has already finished remote CI.

The current patch reruns the touched partner matrix, not the entire original local launch audit. Existing fixture/physical-device/production boundaries in the main report remain unchanged. CodeQL must rescan this new head; no alert is manually dismissed and no security gate is bypassed. This PR is not merged or deployed by this recovery.

## Evidence

Original CodeQL alert: https://github.com/PawSpaceIND/pawspace-tech-platform/security/code-scanning/228
Original failed check: https://github.com/PawSpaceIND/pawspace-tech-platform/runs/108643527114
Original remote Web tests: https://github.com/PawSpaceIND/pawspace-tech-platform/actions/runs/36327400864/job/108642869680

Local test report SHA-256: `46a2eac080c4d609bb0aaadd485461150f3b7ba632582ee8d3eacece4641c5ed`.
