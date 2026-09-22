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

### What shipped for each, and what a tester needs before they can see it

Recorded 2026-09-22, after the decisions above were built. Decisions 8, 9 and 10 shipped in #968;
1-7 in #971. Four depend on seeded rows, so a **staging redeploy** must run before a tester can see them -
`INSERT OR IGNORE` does nothing to a row staging already carries, which is why each seed now also carries
an upward repair scoped to the rows the seeds own.

| # | Built | Redeploy first |
| --- | --- | --- |
| 1 | Card, review line and bill all read Rs 499 from `lib/meet-and-greet.ts`; no rupee figure is typed into the screen. The bill says "paid separately" because a Meet & Greet is its own request and never joins the stay quote. | |
| 2 | Grooming and boarding. Boarding releases the stay, the capacity lock and the scheduling reservation; no refund row is written. A booking that HAS taken money still goes to policy review, and a checked-in stay is still an Operations incident. | |
| 3 | The stage is honoured only on a UAT deployment and fails closed elsewhere. | yes |
| 4 | Web chat had no staff reply path at all; it has one now. Consent is asked in-thread on takeover. | yes (rollout row) |
| 5 | One resolver shared by all three matchers; `lead-owner-identity`'s duplicate alias map is gone. | |
| 6 | The queue carries the canonical name, with the CRM contact as a named fallback, and opens the thread directly. | |
| 7 | Provider records the collection; the ops override needs `payments.manage` plus a stored reason and writes `withheld_pending_collection`, never `accrued`. | |
| 8 | Placeholder rate published, marked UAT-ONLY-NOT-PRODUCTION. The repair publishes a stale row without touching the figure. | yes |
| 9 | 30 minutes for the named UAT roster. Taxi and walking stay at 3 minutes, deliberately. | yes |
| 10 | CL, SL and EL exactly as the /me placeholder advertises. An unknown code still answers 409. | yes |

The caveat above still holds for decisions 3 and 4: both are built to work the moment the external setup in
section 1 lands, and until then a customer turn meets an honest refusal and a WhatsApp move answers 503
saying no message was sent. Neither can be signed off by a tester before those keys exist.

## 3. Verification that only a human on staging can close

- Browser journeys **on the deployed staging host**. The sandbox that produced this branch cannot reach it, so every
  browser result here came from a local build of the exact SHA. Staging carries the CI certification (28/28).
- The "Automated human sweep (staging)" workflow only runs from `main` and requires the SHA to be contained in `main`,
  so it cannot cover a PR-branch SHA. Run it after merge.
- Publishing grooming packages in staging Pricing Control: every local run had to publish them first
  (`PATCH /api/pricing-control`, reason "UAT publish"). Staging needs the same or `/v2/grooming` cannot book.

## 4. Repository gates that need a human decision

- **Gitleaks Secret Scan — RESOLVED 2026-09-22 by owner decision.** It was red for this PR's commit range: test-only
  literals (QA idempotency labels, a test signing value, and the Razorpay test-mode key-id **format** fixture (`rzp_test_` prefix, body `taxiFixture`)).
  The current source no longer contains key-shaped literals, but the historical commits in the range still do, and
  because gitleaks scans commit history, editing today's files cannot clear a finding pinned to an old commit.
  This file previously recorded that `.gitleaksignore` was deliberately left untouched because it is a
  security-policy gate, and that a maintainer should decide. The owner made that call: the five findings on #971
  (all in `1dc15704`, already on `main`) were each verified as synthetic and listed as exact
  `commit:file:rule:line` fingerprints in `.gitleaksignore`, alongside the six entries the repo already carried for
  the same reason. Exact fingerprints were used, not path or rule exclusions, so the rules stay armed for anything
  new in those same files.
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
