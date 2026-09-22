# What is still open before human testing can be called complete (2026-09-21)

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

## 2. Owner decisions (policy, not code)

> **UAT status, 2026-09-22 - all ten decisions taken and built.** The owner answered every item in this
> section. Decisions 8, 9 and 10 shipped in #968; decisions 1-7 are built on this branch. Each is now
> testable by a human on staging **after a redeploy**, because three of them depend on seeded rows.
> The numbered list below is kept as the record of what was open and why; the answer taken is added to
> each line. Nothing was invented: where a number, a window or a rate was needed, the owner gave it.


1. **Sitting Meet & Greet pricing** — the customer card says ₹500, the review line says ₹0, and no ₹499/₹500 rule exists anywhere in the code. The dead control is a defect and is being fixed; the price itself is an owner decision and was not invented.
   - **DECIDED: Rs 499** everywhere the customer sees a price. Built: the card, the review line and the bill all read it from `lib/meet-and-greet.ts`, and no rupee figure is typed into the screen. The split-payment note no longer claims a fee is collected at checkout, because none is.
2. **Cancellation of unpaid reservations** — an unpaid grooming or boarding reservation cannot be cancelled by the customer ("Cancellation unavailable"); boarding request controls are disabled while unpaid. Intended or not is a policy call.
   - **DECIDED: customers may cancel.** The block was a defect. Built for grooming and boarding; boarding releases the stay, the capacity lock and the scheduling reservation. No money moves and no refund row is written. A booking that HAS taken money still goes to policy review, and a stay already checked in remains an Operations incident.
3. **Customer AI rollout stage** — currently `staff_only`, so every customer turn is handed off as `rollout_gated`. Moving the stage is an owner decision.
   - **DECIDED: open to customers in UAT only.** Built: the stage is honoured only on a UAT deployment and fails closed elsewhere, and the staging seed sets it. With no provider key the assistant still hands off honestly rather than inventing an answer.
4. **Human contact channel for web-chat handoffs** — after a staff takeover there is no staff→customer reply path on a non-WhatsApp thread, and the customer is told only that the conversation is being routed. Which channel answers, and what the customer is promised, is an owner decision (the missing reply control is being fixed once the channel is chosen).
   - **DECIDED: ask in the web chat for WhatsApp consent first; otherwise stay there.** Built: web chat now has a staff reply path at all (it had none), the consent question is put in-thread on takeover, and with no number, a CRM opt-out or no consent the customer is told a human will reply in that chat. With the WhatsApp keys unset the move answers 503 and says no message was sent.
5. **Lead-routing policy key and assignment UI** — assignment policies match on a free-text city label; the CRM stores a city id. The matching now accepts both, but whether policies should be keyed by city id, and whether staff get an assignment screen at all, is an owner decision.
   - **DECIDED: key on city id; no assignment screen this round.** Built: one resolver, shared by all three matchers, so a policy scoped to `blr` now routes a lead whose CRM area reads Bengaluru. Existing label-written scopes keep working.
6. **Employee-AI thread identity** — handoff rows are keyed to CRM contact ids, so the queue shows masked ids instead of canonical customers.
   - **DECIDED: show the canonical customer.** Built: the queue carries the canonical name (CRM contact as a named fallback), and a queued escalation is now reachable on its own rather than only as a badge on a thread that happened to be listed beside it.
7. **Completion and payout before cash collection** — providers can complete a pay-after-service job before the cash is collected.
   - **DECIDED: no completion without a recorded collection, unless Operations authorises it with a stored reason - and the override does not release the payout.** Built, including the provider's own record-collection action. Recording a collection captures nothing.
8. **Trainer compensation rule** — a completed training session is held "pending rate configuration" because no rate exists.
   - **DECIDED: seed an obvious placeholder rate, marked UAT-ONLY-NOT-PRODUCTION.** Shipped in #968; this branch adds the upward repair so a staging row left unpublished is published.
9. **Seeded sitter/host acceptance window** — three minutes, which expires before a local payment can be made.
   - **DECIDED: 30 minutes** for the named UAT sit/host roster. Shipped in #968. Taxi and walking stay at 3 minutes, deliberately.
10. **An active leave policy for UAT** — the 500 is fixed and the refusal is governed, but whether a policy is seeded for testers is an HR/owner call.
   - **DECIDED: seed CL, SL and EL** exactly as the /me placeholder advertises. Shipped in #968; this branch adds the upward repair for policies and balances. An unknown code still answers 409.

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
