# UAT script — Phase 2 wiring (G3–G7)

Targeted script for the fixes in PR #847, on **https://pawspace-staging.karthik-fce.workers.dev**.
Read `docs/UAT-TESTER-GUIDE.md` first for identities, the access code and the sandbox boundaries; this
document only covers what PR #847 changed.

Deployed and certified as `Deploy staging` run #258. **If you are testing after that PR merged, ask ops
to re-deploy first** — run #258 deployed commit `30f3e02`, and two later commits (`14839b2`, `442e6eb`)
are in the PR.

Everything below is sandbox. No live money moves and no real SMS is sent.

---

## Before you start

| You need | How |
|---|---|
| A partner session | `/partner-app`, OTP sign-in with `9000000901` (city-wide Grooming Team — most auto-assignments land here). OTP is shown on screen. |
| A customer session | App root on your phone. Book as a guest and log in with any Indian-format mobile number; the OTP is shown on screen. A fresh number is a fresh customer. |
| A staff session | `/staging-login` as Founder or Manager, access code from ops. |
| Ops (for T3 only) | Someone who can run `wrangler d1 execute` against the staging D1. |

---

## T1 — Partner sees the handling requirements and add-ons (G4)

These come out of the booking's `pricing_json`, which the customer's own booking writes. So the
requirement text you type as the customer is what the partner must see.

1. **As a customer**, book Grooming. On the care step, enter a **safety note** you will recognise —
   e.g. `Nervous around clippers`. Select at least one **add-on**. Add a **special instruction** too.
2. Choose **Pay after service** and complete the booking. Note the booking id.
3. **As the partner** (`9000000901`), open `/partner-app` → **Jobs** and select that booking.

**Expect:**
- A **Handling requirements** panel listing your safety note and your special instruction.
- An **Add-ons booked** line naming the add-ons you chose.
- **Where** showing the zone and city, and **Package** showing the package name.

**Known cosmetic detail — do not file a bug:** the requirement renders with its source prefix, as
`grooming safety:Nervous around clippers`. The prefix is how the booking stores it. Tidying the
prefix into a label is a follow-up, not a defect in this PR.

**Also expect (G4, amounts):** on this **pay-after-service** job the Payment line reads
`pay after service · <status> · collect ₹<total>`. Book a second Grooming job with **Pay now** instead
and the same line reads `· ₹<total> due online` — never "collect". Those two amounts are different
fields and swapping them was the bug; if a prepaid job says "collect", that is a real bug, file it.

**If the package covers several visits**, the Time line reads `visit 1 of N`.

---

## T2 — Multi-visit, timeline and invoice stamps (G4)

On the same job detail:

- **Recent activity** lists up to five lifecycle events with times (accept, on the way, arrived …).
  It shows the event name and time only. If you ever see a phone number, an email, an address or a
  staff note in this list, **stop and report it** — that would be a privacy defect.
- Once a proof photo is approved, **Service proof** carries an `updated <time>` stamp.
- Once an invoice exists, it carries an `issued <time>` stamp.

---

## T3 — Expired pay-after-service payment request (G3) — needs ops

**You cannot reach this state by waiting.** A payment link is valid for 24 hours, so ops must age it.

1. **As the partner**, take the pay-after-service job from T1 through to **Complete job**.
2. Still on that job, tap **Create payment request**. Confirm you see the amount, an **Open sandbox
   checkout** link, the QR payload, and a **Collectable until \<time\>** line. Note the booking id.
3. **Ops:** age the request past its expiry.

   ```sh
   npx wrangler d1 execute DB --config dist/server/wrangler.json --remote \
     --command "UPDATE post_service_payment_requests SET expires_at = 1 WHERE booking_id = '<BOOKING_ID>';"
   ```

   `expires_at` is epoch **milliseconds**; `1` is safely in the past. Do not touch
   `booking_payments.status` — the request must still be unpaid for this state to appear.
4. **As the partner**, tap **Refresh payment status** (or reopen the job).

**Expect:**
- The status reads **expired**.
- Copy naming the expiry: *"This payment link expired on \<time\>. A governed replacement link can be
  issued for the same booking."*
- A **Create replacement payment request** button — this is the fix. Before it, the screen told the
  partner to create a replacement and offered no way to do so.
5. Tap it. Expect a fresh collectable link with a new **Collectable until** time.

**Negative check that matters:** on a booking whose payment is already **captured**, the panel must say
the payment is settled and **must not** offer a replacement link. If a captured booking offers one,
that is a real bug.

---

## T4 — Governed customer sign-in message (G5)

The fix is server-side: eleven customer endpoints used to answer a signed-out request with a generic
failure ("Unable to open payment") instead of saying to sign in.

**Most reliable repro — browser console.** On the staging origin, in a window with **no customer
session** (a fresh incognito window, or before you log in):

```js
await (await fetch('/api/payment-order', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ bookingId: 'uat-probe' }),
})).json()
```

**Expect** HTTP `401` and
`{"error":"A verified customer sign-in is required before a payment can be opened. Sign in and try again."}`

**Expect NOT** `"Unable to open payment"` — that is the old redacted answer and would mean the fix
regressed.

Repeat with `/api/pawspace-wallet`, `/api/paw-points` or `/api/pet-emergency` (same shape, `POST` with
any JSON body). Each should answer `401` with *"A verified customer sign-in is required. Sign in and
try again."* — `pet-emergency` previously said "Unable to raise emergency request".

**In-app repro (writes only).** As a guest, open **Account** and try to save a profile or pet change.
The toast shows the sign-in sentence.

> **Read paths look unchanged in the app, and that is expected.** `CustomerAccountView` discards the
> response body on its initial GET and renders its own "Canonical family record is unavailable"
> message, so the improved server message is not visible there. The server is correct; surfacing it on
> reads is a separate client change, not part of this PR.

**Also governed now (worth one check each):**
- Saving a service address that cannot be geocoded answers *"The doorstep address could not be
  resolved to verified map coordinates. Re-pick the address or move the pin, then save again."*
- Cross-origin blocks are **deliberately still generic**. They should not explain themselves.

---

## T5 — Partner workspace state (G6)

**As the partner**, open `/partner-app` → **Earnings**.

- **Commission partner:** the headline reads **Commission earned** with a non-zero figure when
  commission orders exist, plus **Computed orders** and **Gross order value**. Below, one card per
  commission order (commission on order value, rate mode, due date) and one per payout with its state.
  **Before this PR the tab crashed for commission partners** — it hit the error boundary. If you see an
  error screen here, that is a regression, report it.
- **Contract partner:** the headline reads **Computed net payout**, with settlement and incentive cards.
- **Never** expect booking value presented as partner earnings. Payout figures come only from the
  governed settlement/commission ledger.

Also expect, when they apply:
- **Shift liveness matched** — confirms today's liveness check passed for the shift date.
- **Onboarding is \<state\>** — when the partner profile is not yet active, with a link to onboarding.
- **Service proof still outstanding** — booking ids and the missing proof stages, with the note that
  this holds up that booking's settlement.
- If the identity has no provider record bound, expect **"Earnings are not shown yet"** naming the
  reason — **not** ₹0. A silent zero here is a bug.

**Cross-account check (this one matters).** Sign out from **More → Sign out**, sign in as a *different*
partner (`9000000904`), and open **Earnings**. None of the previous partner's booking ids may appear in
**Service proof still outstanding**. Seeing them is a real defect — report it.

---

## T6 — GPS: withheld doorstep and refused fixes (G7)

**As the partner**, take a job to **Start journey** so it is `on_the_way`, then open **GPS**.

1. **Normal case:** **Destination** shows the verified doorstep, ETA and distance appear once a fix is
   accepted, and **Open turn-by-turn in Google Maps** is offered.
2. **Withheld address:** on a booking completed more than 72 hours ago (the dispute window), the card
   must read **"Doorstep not shared yet"** with the reason *"Address access for this booking has closed.
   Ask Ops to reopen it if you still need to travel here."* — **not** a bare "Verified customer
   doorstep" placeholder with nothing else. The placeholder-with-no-explanation was the bug.
3. **Refused fix:** hard to force deliberately; if it happens (poor signal indoors, or a phone whose
   clock is wrong), expect a plain-language amber line such as *"GPS accuracy is outside the approved
   range. Move into the open or away from tall buildings."* plus *"The last trusted fix and ETA above
   are unchanged."* — **not** a raw `accuracy_outside_approved_policy`. Confirm the previously shown
   ETA is still on screen; a rejected fix must not blank it.

To force case 3, an easy route is to set the phone's clock forward several minutes (disable automatic
time), which produces *"This phone's clock is ahead of PawSpace. Turn on automatic date and time."*
Set it back afterwards.

---

## What is NOT in this PR

Do not test these; they are documented as backlog:

- **Admin prototype tabs.** `/admin` still shows built-in sample rows on Groomers, Payments, CRM,
  Tickets, Subscriptions, Boarding, Mobility, Food and Workforce. The screen says so. Overview, Live
  calendar and Bookings are live.
- **Customer-side live tracking.** The customer's provider card is still a placeholder with no live map
  or ETA. No customer-facing tracking read model exists yet.

---

## Reporting

Include the **booking id**, the **partner number or customer mobile** you used, and the **screen**. For
anything money- or privacy-shaped (a wrong amount, one partner's data on another's screen, contact
details in the activity timeline), mark it **blocking**.
