# PawSpace — Pre-UAT Certification

**Pinned freeze SHA:** `028e62111bf2af15170d7b8400b13135419fb6de` (`main`)
**Certification date:** 2026-09-12
**Status:** ✅ Automated certification gate PASSED — cleared to enter Human UAT

This record certifies the automated test, build, lint, and type gates for the pinned
commit above. It certifies **what the automated battery proves**; it is not a claim of
completeness for scope consciously deferred to the post-launch roadmap (see below), nor a
substitute for the live verification that is the purpose of Human UAT.

---

## 1. Authoritative CI — Release CI run #4631 (this exact SHA)

- Run: https://github.com/PawSpaceIND/pawspace-tech-platform/actions/runs/34708611744
- Head SHA: `028e62111bf2af15170d7b8400b13135419fb6de`
- Conclusion: **success — 13/13 jobs green**

| Job | Result |
|---|---|
| Build gate | ✅ |
| Typecheck | ✅ |
| Lint | ✅ |
| Artifact validation | ✅ |
| Web tests (tracked backend battery) | ✅ |
| Backend (`npm test`) | ✅ |
| Test harness hook paths (registerHooks + loader-hook) | ✅ |
| Evidence class inventory | ✅ |
| Runtime D1 regression | ✅ |
| Background scheduler D1 | ✅ |
| Pricing Control D1 regression | ✅ |
| Production readiness truth D1 | ✅ |
| UAT integrity recovery D1 | ✅ |

## 2. Local corroboration on the pinned SHA

Reproduced on the exact SHA with a clean tracked tree and `node_modules` reinstalled from
lockfile (`npm ci`, 644 packages incl. `@capacitor`, `@playwright/test`).

| Phase | Result |
|---|---|
| `npm ci` | exit 0 |
| `npm run build` (verified Sites artifact) | exit 0 |
| Backend battery — 714 tracked suites | **5,828 tests, 5,828 pass, 0 fail, 0 skip** |
| Certification suites — 2 (`PAWSPACE_PRODUCTION_ENFORCE=false`) | **10 tests, 10 pass, 0 fail** |
| Hardened persona E2E — 5 journeys × {Desktop Chrome, Pixel 7} | **all green, 0 fail** |
| CX-visibility proof (Razorpay capture → Meta 503 → CX pending) | **1 pass** |

- **Backend total: 5,838 test cases, 0 failures.**
- **Browser E2E total: 78 tests, 0 failures.**

E2E per-journey (each ran once per project, no retries):

| Journey | Desktop Chrome | Pixel 7 |
|---|---|---|
| 00-identity | 3 ✓ | 2 ✓ |
| 01-customer | 7 ✓ | 7 ✓ |
| 02-partner | 6 ✓ | 6 ✓ |
| 03-admin | 21 ✓ | 21 ✓ |
| 04-multi-actor | ✓ | ✓ |
| CX-visibility proof | 1 ✓ | — |

The persona E2E browser lane is a manual-dispatch workflow that had not run in CI on this
SHA; this local run (and a subsequent workflow-dispatch) provides its evidence for
`028e6211`.

## 3. Consciously deferred scope (post-launch roadmap — not blockers)

Accepted by the founder as out of scope for this freeze:

- Insurance / liability / claims module
- GST e-invoicing (IRN/IRP) and e-way bill generation
- Accounting-package export (Tally / Zoho)
- Disaster-recovery / backup drills (RPO/RTO, tested restore)
- External observability stack (centralised logs/metrics/tracing/alerting)
- A dedicated general audit-log-immutability test suite

## 4. What Human UAT must still validate

Structurally outside automated coverage (sandbox-locked here) and therefore the purpose of
UAT itself:

- Real-money Razorpay capture / refund / payout on live sandbox+production keys
- Live third-party delivery: Meta/WhatsApp, Exotel, IDfy
- Real native mobile devices (Capacitor customer/partner apps)

## 5. Certification statement

On the evidence above, the automated certification gate for `028e6211` is **fully passed**
— build, typecheck, lint, 5,838 backend cases, and the full persona E2E browser lane are
green on the exact frozen commit, corroborated by Release CI run #4631. This SHA is
**cleared to enter Human UAT**, on the terms in sections 3 and 4.
