# What is still open before human testing can be called complete (2026-09-21)

> **Update 2026-09-22.** Section 2's ten owner decisions are now **answered** — see that section for each
> call and the two follow-ups. Section 1 (external setup) and section 3 (verification only a human on
> staging can close) still stand, and two of the answered decisions cannot be verified until section 1's
> AI provider and external messaging are in place.

This is the honest residual list for PawSpace V2 on branch `fix/v2-human-test-launch-20260921`.
Nothing here is a guess: each line names what was actually observed and who has to act.

## 1. External setup nobody in the build can supply

| Item | What blocks it | What was verified instead | Who acts |
| --- | --- | --- | --- |
| Razorpay TEST capture, signed webhook, refund, invoice reconciliation | No Razorpay sandbox credentials in the local environment; every Pay is an honest inline 503 ("Razorpay test checkout is not configured"). Staging certification reports Razorpay TEST **is** configured there, so this line can be closed on staging by a human. | Reservation, recovery, replay and refusal paths end to end; no fake success anywhere. | Ops/owner, on staging |
| Real AI answers (chat, bot routing quality, voice STT→AI→TTS) | No AI provider key and no Workers AI binding locally; every turn hands off honestly. Exact refusal strings recorded in the AI findings. | Handoff, staff takeover, return-to-AI, ownership boundaries, refusal visibility, audit rows. | Owner (provider funding/config) |
| Pet Taxi route ETA / neighbourhood search | `GOOGLE_MAPS_SERVER_API_KEY_UAT` unset locally → governed 503. Customer copy no longer names the variable (V2-059). | Quote refusal, Boarding→Taxi continuation UI, trip lifecycle with route classes. | Ops/owner |
| Durable media storage for service proof | Media adapter not connected: uploads are hashed and discarded (`objectStored=false`, `adapterConnected=false`). | Upload, review and approval flow; the UI now states what actually happened rather than "uploaded and verified". | Ops/owner |
| WhatsApp / Haptik / SMS external delivery | `HAPTIK_API_KEY` unset (503), WhatsApp UAT webhook secret unset (503), `PAWSPACE_COMMUNICATION_ENV` unset locally. | Simulated inbound refused honestly; consent gates enforced. | Ops/owner |
| Native device behaviour (background GPS, camera, notifications, storage) | Not reachable from a headless browser at all. | Browser geolocation including a real `PERMISSION_DENIED` path, geofence refusal and recovery. | Human tester on a device |

## 2. Owner decisions — ANSWERED 2026-09-22

All ten were put to the owner (karthik@pawspace.in) and decided. Recorded here so the answers outlive the
conversation they were given in. Nothing below was invented; each is the owner's own call, and the two
follow-up questions were raised because the chosen option had a consequence worth closing.

| # | Decision | Owner's answer |
| --- | --- | --- |
| 1 | Sitting Meet & Greet price | **₹499.** The card's ₹500 and the review line's ₹0 both become ₹499, backed by a real rule. |
| 2 | Cancelling unpaid reservations | **Allow it.** The current "Cancellation unavailable" is a defect; the customer may cancel and the slot is released. |
| 3 | Customer AI rollout stage | **UAT only.** Customers on staging get AI; production stays gated. |
| 4 | Web-chat handoff reply channel | **WhatsApp**, with consent asked in the web chat first (see below). |
| 5 | Lead-routing policy key | **Key by city id.** No staff assignment screen this round. |
| 6 | Employee-AI thread identity | **Key handoffs to the canonical customer**, so staff see who they are answering. |
| 7 | Completion before cash collection | **Require recorded collection before completion**, with an ops override (see below). |
| 8 | Trainer compensation | **Seed an obvious placeholder rate** for UAT. Not a real compensation policy and must not be read as one. |
| 9 | Sitter/host acceptance window | **30 minutes** (was three, which expired before a tester could pay). |
| 10 | Leave policy for UAT | **Seed a generic sandbox policy**, clearly marked as test data. |

Two follow-ups, raised because the chosen option left a hole:

- **7a. Cash-before-completion release valve — ops authorises.** Requiring recorded collection would otherwise
  strand a provider at a customer's door when the customer wants to pay later. The provider requests an
  override, ops approves, the job completes with the reason recorded, and payout stays withheld.
- **4a. WhatsApp handoff with no consent — ask in the web chat first.** Moving a thread to WhatsApp needs a
  number and consent, and CRM opt-out is sticky, so some customers have no WhatsApp route. The customer is
  asked in-thread before the move, which keeps both the consent and the record.

**Two of these are configurable now but not verifiable yet**, because they depend on the external setup in
section 1: decision 3 (the AI provider is unfunded, so a customer turn still meets a refusal) and decision 4
(external messaging is not connected, so nothing actually sends). Both should be built so they work the
moment those land — but neither can be signed off by a tester until then.

## 3. Verification that only a human on staging can close

- Browser journeys **on the deployed staging host**. The sandbox that produced this branch cannot reach it, so every
  browser result here came from a local build of the exact SHA. Staging carries the CI certification (28/28).
- The "Automated human sweep (staging)" workflow only runs from `main` and requires the SHA to be contained in `main`,
  so it cannot cover a PR-branch SHA. Run it after merge.
- Publishing grooming packages in staging Pricing Control: every local run had to publish them first
  (`PATCH /api/pricing-control`, reason "UAT publish"). Staging needs the same or `/v2/grooming` cannot book.

## 4. Repository gates that need a human decision

- **Gitleaks Secret Scan** is red for this PR's commit range: ten test-only literals (QA idempotency labels, a test
  signing value, and the `rzp_test_taxiFixture` key-id **format** fixture). The current source no longer contains
  key-shaped literals, but the historical commits in the range still do. The repo's convention for exactly this case
  is to list the exact fingerprints in `.gitleaksignore`; that file was deliberately **not** touched here because it
  is a security-policy gate. A maintainer should decide.
- **CodeQL — RESOLVED.** This previously read as an open item: one new high-severity alert whose rule
  could not be read from the build sandbox. The owner opened the alert page and supplied the detail, and
  it turned out to be alert #55, `js/user-controlled-bypass` (CWE-290 / CWE-807), at
  `app/api/grooming-payment-sandbox/route.ts:13` — **on `main`, first detected two weeks before this
  branch existed**. It surfaced here only because this PR's diff is large enough for CodeQL to widen its
  net, exactly as the check's own caveat warns. No open PR introduced it.

  On escalation it was a false positive: the endpoint serves five actions, the caller names the action in
  the body, and that value picks the authorization branch — but each branch enforces the permission its
  own work needs, and `requireProviderOwnership` throws 403 unless the actor is bound to that provider, so
  the weaker branch grants only the weaker capability.

  What it was right about was the missing validation, and that was a real defect: `action` was checked
  only for emptiness, so an unrecognised value fell past every branch and was handled by the gateway-event
  simulator. Reverting the fix and re-running the new regression showed `action:"escalate"` answering 201
  and processing a `payment.captured` event.

  Fixed on `main` in #964 with the remedy CodeQL itself prescribes — a fixed `POST_ACTIONS` allow-list the
  `Input` type derives from, resolved before the value decides anything, with every branch dispatching on
  the validated literal and the final branch named rather than a fall-through. The `CodeQL` check is
  green on this PR as of `aec412e`.
