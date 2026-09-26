# PawSpace Staging — Human UAT Tester Guide

**App:** https://pawspace-staging.karthik-fce.workers.dev
**Staff login page:** `/staging-login` — ask ops for the current access code. It is a repository secret
and is deliberately not written here; the code that used to be printed in this guide and in the deploy
log is now revoked.

**Sign in as one of the seeded staff identities below.** UAT sign-in resolves your role from the staff
directory: an email that is not an active `app_users` row is refused at sign-in. It used to accept any
address and grant it founder access with every permission, which meant no role boundary could be tested
and the access code alone conferred full authority.

---

## 1. Test identities

| Role | Email (staff login) | Sees |
|---|---|---|
| Founder (everything) | `founder@pawspace.in` | All modules |
| Finance | `anjali.finance33@tkpetcare.in` | Finance, statutory compliance, payouts |
| Manager | `jyoti.manager39@tkpetcare.in` | Ops, scheduling board, CRM |
| Groomer (employee) | `asha.groomer1@tkpetcare.in` | Partner/self-service surfaces |
| Associate | `anita.associate17@tkpetcare.in` | Limited staff view |

These five are seeded as active `app_users` rows by **`scripts/employee-seed.sql`** — load it (alongside
`staging-seed.sql` and `uat-demo-seed.sql`) or none of them can sign in, because sign-in refuses any
email that is not an active staff row. `founder@pawspace.in` is the owner identity (not on a payroll
band), seeded by that same file.

**Demo module identities** (present once `scripts/uat-demo-seed.sql` is loaded — every module page then
opens with data instead of blank): `uat.demo.manager@tkpetcare.in` (manager),
`uat.demo.sales1@tkpetcare.in` / `uat.demo.sales2@tkpetcare.in` (sales, appear on the leaderboard and
in incentives), `uat.demo.groomer@tkpetcare.in` (linked to a real provider — sign in as this one to see
the Partner workspace with jobs, a live assignment and earnings). Sign in with the same access code. Each of these is a seeded `app_users` row, which is what makes them
usable — and each gets only its own role's permissions, so signing in as the associate really does show
you an associate's view.
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
- **Partner app as a UAT groomer** (`/partner-app`): sign in with the partner OTP using one of the seeded UAT groomer
  numbers — `9000000901` (city-wide Grooming Team, the groomer most auto-assignments land on), `9000000904`
  (Rahul M., South), `9000000903` (East), `9000000905` (North), `9000000906` (West), `9000000907` (Central). The
  OTP is shown on screen (sandbox). The seeded roster (`scripts/uat-staging-provider-capacity.sql`) covers all
  five Bengaluru zones for Grooming, Training, Boarding, Sitting, Walking and Taxi, so "No provider is available"
  on an otherwise valid slot means the roster was not loaded — re-run the **Seed staging D1** workflow.
- **Partner app as a UAT trainer**: the training providers have partner OTP numbers too — `9000000931`
  (city-wide Training Team), `9000000933` (Kavya R., South), `9000000932` (Arjun T., East), `9000000934`
  (Nikhil B., North), `9000000935` (Anitha G., West), `9000000936` (Rohan D., Central). The city-wide team has
  four more seats, so testers who pick exactly the same Training date and time still each get a trainer:
  `9000000937` (Training Team 2), `9000000938` (Team 3), `9000000939` (Team 4), `9000000940` (Team 5). Sign in
  with the number of the seat named on your booking. A partner identity is
  the phone number, so "switching from groomer to trainer" means signing out and signing in with a trainer's
  number. Note that `/partner-app` lists and works **grooming** work orders only; a trainer signs in and sees
  the shell, but training sessions are not yet worked from this app.
- **Switching provider without a phone number** (`/partner-app` → More → *Switch UAT provider*): staging-only.
  Pick any live provider in the seeded roster (groomer, trainer, host, sitter, walker, taxi) and enter the same
  UAT access code used at `/staging-login`; the app re-checks the session and opens as that provider.
- **Sign out** (`/partner-app` → More → *Sign out*, or tap the green identity pill in the header): ends the
  partner session on this device and returns to the OTP sign-in.
- **Partner job lifecycle** (`/partner-app`, signed in as the assigned groomer): Accept job → Start journey →
  Mark arrived → Start service → upload before/after photos → Add service proof → Complete job.
  - **Mark arrived is GPS-gated**: the server only accepts it with a fresh GPS fix within 250 m of the customer's
    doorstep. On a phone, open **GPS & route → Start GPS** first, and book the test job to the address you are
    actually at. Without a fix the app now says so instead of failing silently.
  - **Photos need Ops approval** (maker/checker): after both photos show "awaiting Ops approval", a *different*
    person signs in at `/staging-login` (Founder or Manager), opens **Control → Customer booking lifecycle →
    Service proof awaiting review**, writes a reason and approves each photo. The partner then taps **Refresh
    proof status → Add service proof → Complete job**. The uploader can never approve their own photo.
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

`NOT TESTED` is not a pass. Roughly a dozen customer and partner routes need a real session, and the
sweep says so rather than scoring them green.

## 6. What NOT to test yet (Phase 2/3 — we'll announce)

- Payment edge-case abuse (double-pay, refund abuse) — payments audit is landing.
- OTP/identity abuse cases — identity audit is landing.
- Deep back-office regression — after the E2E gate (Task 24).
