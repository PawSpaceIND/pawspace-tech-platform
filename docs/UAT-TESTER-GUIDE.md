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
- **Finance compliance** (`/team/finance-compliance`, finance login): calendar due dates, monthly close checklist, TDS tab.

## 5. How to file an issue

One issue per line in the shared sheet, format:

`[page/flow] · [what you did] · [what happened] · [what you expected] · [phone model + browser] · [screenshot]`

Severity guide: **P0** = money wrong / booking lost / crash · **P1** = flow blocked with workaround · **P2** = visual/copy.

## 6. What NOT to test yet (Phase 2/3 — we'll announce)

- Payment edge-case abuse (double-pay, refund abuse) — payments audit is landing.
- OTP/identity abuse cases — identity audit is landing.
- AI chat / voice bot — channel audit is landing.
- Deep back-office regression — after the E2E gate (Task 24).
