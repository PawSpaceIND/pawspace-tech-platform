# PawSpace Staging — Human UAT Tester Guide

**App:** https://pawspace-staging.karthik-fce.workers.dev
**Staff login page:** `/staging-login` · access code: `pawspace-uat-2026`

---

## 1. Test identities

| Role | Email (staff login) | Sees |
|---|---|---|
| Founder (everything) | `founder@pawspace.in` | All modules |
| Finance | `anjali.finance33@tkpetcare.in` | Finance, statutory compliance, payouts |
| Manager | `jyoti.manager39@tkpetcare.in` | Ops, scheduling board, CRM |
| Groomer (employee) | `asha.groomer1@tkpetcare.in` | Partner/self-service surfaces |
| Associate | `anita.associate17@tkpetcare.in` | Limited staff view |

**Demo module identities** (present once `scripts/uat-demo-seed.sql` is loaded — every module page then
opens with data instead of blank): `uat.demo.manager@tkpetcare.in` (manager),
`uat.demo.sales1@tkpetcare.in` / `uat.demo.sales2@tkpetcare.in` (sales, appear on the leaderboard and
in incentives), `uat.demo.groomer@tkpetcare.in` (linked to a real provider — sign in as this one to see
the Partner workspace with jobs, a live assignment and earnings). Sign in with the same access code.
All demo rows are prefixed `UATD-` / `Demo ·` so they are obvious in every list.

**Customers do NOT log in here.** Open the app root on your phone, browse as a guest, and log in with any Indian-format mobile number when booking — the OTP is **shown on screen** (sandbox; no real SMS is sent). Every fresh number creates a fresh customer, which is the easiest way to test the new-customer welcome coupon.

## 2. Sandbox rules (not bugs)

- **No real money.** All payments are sandbox captures. "Pay online" succeeds without a card.
- **No real SMS / WhatsApp / push.** OTPs display in the app; notifications land in staff alert queues.
- **Videos:** every service banner has a video slot labelled as awaiting real footage — intentional.
- **After a deploy** (we announce them), the first minute can serve a mix of old/new versions. Retry once before filing.
- **Slot taken / no schedule available** with several testers on the same date is usually the roster being genuinely full (2–4 seeded providers per service). Spread your dates across the next 2–3 weeks.

## 3. Customer journeys to run (Phase 1)

Run each on a **real phone** (both iOS Safari and Android Chrome if possible):

1. **Guest browse → first booking (Grooming):** search on home → welcome offer popup appears → pick Grooming → add/edit a pet inline on the pet step → package → slot → checkout shows available coupon codes, WELCOME pre-filled for new customers → confirm → booking ID shown.
2. **Boarding with split payment:** overnight stay **5+ nights**, starting 3+ days out → choose "Reserve with 50% now" → confirm → the confirmation states the balance and its due date (24h before check-in).
3. **Boarding dog + cat:** default pet pair must find at least one host (Priya & Dev).
4. **Pet Sitting** (visit + overnight), **Training** (multi-session programme), **Dog Walking** (recurring weekday walks), **Pet Taxi** (pickup/drop + time), **Fresh Food** (cart with 2 items, optional repeat delivery), **Relocation** (submit one domestic AND one international enquiry).
5. **My Pets tab:** add a pet with age + weight, edit it in place, try an invalid weight (should be rejected with a clear message).
6. **Host profiles:** open a boarding host card — badges, reviews, stats. Request a Meet & Greet: house visit with a 4-day stay should quote ₹499; with a 5-day stay it should be free.

## 4. Staff journeys (Phase 1-lite; deep testing in Phase 3)

- **Partner job feed** (`/partner/jobs` via groomer/manager login): new bookings appear; boarding requests show Accept/Decline.
- **Scheduling board** (`/team/scheduling?date=YYYY-MM-DD`, manager): day columns per provider; try a reassign.
- **Relocation triage** (`/team/relocation-enquiries`): your submitted enquiries appear with Domestic/Intl tags.

### AI assistant (read the state before judging the screens)

The assistant is deliberately fail-closed: it answers nobody until four separate conditions are met.
Start at **`/team/ai/configuration`** — the panel at the top ticks or crosses each one and says what to
do about it, so "the AI does nothing" is never a mystery:

1. Model provider connected (a `PAWSPACE_AI_PROVIDER_API_KEY` secret). Not set on staging by default.
2. Assistant grounding activated — press **Install starter assistant grounding** if it is missing.
3. Rollout audience widened on **`/team/ai/rollout`** (`off` → `staff_only` → `customers`).
4. No kill switch thrown (the Disable/Enable AI buttons on the same screen).

With the demo seed loaded, 2 is done and 3 is at `staff_only`, so these screens carry real data:

- **`/team/ai/analytics`** — 7 governed turns across WhatsApp, chat and voice, a containment rate,
  latency, token/cost totals and 2 explicit CSAT ratings. Conversion and first-response deliberately
  read "not claimed" / "not attributable yet"; that is a design decision, not a gap.
- **`/team/ai/handoff`** — pick a canonical thread. `UATD-TH-1` is a customer asking for a human, taken
  over by staff. `UATD-TH-3` is a refund dispute the policy rules blocked and routed to the finance CX
  queue — the assistant is not allowed to answer it at all.
- **`/team/ai`** — the safety contract result and the human review queue for AI suggestions.
- **`/chat`** — Public mode answers from the approved knowledge base only. Authenticated mode needs a
  canonical customer ID (`UATD-CUS-1`) and uses that customer's own record.

Every seeded AI reply came from a scripted sandbox provider recorded as `uat_demo_scripted` on the
turn — none of it is output from a live model.
- **Finance compliance** (`/team/finance-compliance`, finance login): calendar due dates, monthly close checklist, TDS tab.

## 5. How to file an issue

One issue per line in the shared sheet, format:

`[page/flow] · [what you did] · [what happened] · [what you expected] · [phone model + browser] · [screenshot]`

Severity guide: **P0** = money wrong / booking lost / crash · **P1** = flow blocked with workaround · **P2** = visual/copy.

## 5b. Run the screen sweep FIRST

Before anyone browses anything by hand, run this. It opens every route in a real browser, waits for
the client fetches to land, and reports which screens a tester can actually use:

```bash
npm run dev &
npm run sweep                                   # all 130 routes
npm run sweep -- --only=/team                   # one subtree
npm run sweep -- --json=sweep.json              # machine-readable; diff two runs
npm run sweep -- --base=https://<staging-host> --cookie="<session cookie>"
```

**Why this and not clicking around.** Most staff screens are client components: the server sends a
shell and the numbers arrive from `fetch()` after hydration. Every blank screen reported from staging
so far was that shape — a page whose cards sat inside `{data && ...}` and never rendered. `curl` sees
a 200 and calls it fine. A static test sees a file importing the design kit and calls it fine. Only a
browser that waits for the fetches can see an empty page.

What the levels mean:

| Level | Meaning |
|---|---|
| `OK` | rendered real content, or said honestly why it had none |
| `BLANK` | almost no text, nothing to interact with, and no explanation |
| `THIN` | a header and little else, with no empty state and no input — a tester cannot proceed |
| `DATA` | an API the page calls failed in a way the platform does not do by design |
| `BROKEN` | did not load, 5xx, or an uncaught error |
| `MISSING` | 404 |
| `NOT TESTED` | the route correctly refused an anonymous or unfiltered call, so the sweep never saw the real screen — **re-run with `--cookie` to cover these** |

A screen that says "nothing recorded yet", or "open with a canonical booking ID", or "not yet linked
to a provider" is **passing**. It is doing its job on an empty database. Only report what the sweep
flags, and check the excerpt it captured before filing — each finding carries what the page actually
said, so triage does not need a second manual visit.

`NOT TESTED` is not a pass. Eleven customer and partner routes need a real session, and the sweep says
so rather than scoring them green. Covering them takes two different sign-ins, and they are not
interchangeable:

```bash
npm run sweep -- --login=pawspace-uat-2026 --as=founder@pawspace.in
```

signs the sweep in through the real `/api/staging-login` and covers the **staff** consoles. It does
**not** cover `/account`, `/mobile-app`, `/partner*`, `/groomer`, `/trainer` or `/host` — verified: a
founder cookie changes none of them. Those screens resolve a **customer or provider** subject from
`pawspace_identity_session`, which the app's own OTP/assertion flow issues. To cover them, sign in as
a customer in the app (any Indian mobile number; the OTP displays on screen in sandbox), copy the
`pawspace_identity_session` cookie, and pass it:

```bash
npm run sweep -- --cookie="pawspace_identity_session=<token>"
```

A staff cookie will not stand in for a customer one, and the sweep now says which it needs rather than
just "re-run with --cookie".

## 6. What NOT to test yet (Phase 2/3 — we'll announce)

- Payment edge-case abuse (double-pay, refund abuse) — payments audit is landing.
- OTP/identity abuse cases — identity audit is landing.
- Deep back-office regression — after the E2E gate (Task 24).
