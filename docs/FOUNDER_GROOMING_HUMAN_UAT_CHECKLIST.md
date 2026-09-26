# Founder Grooming human UAT checklist (sandbox)

**Goal:** verify Customer → Partner → Money on staging with **no live money**.

**Before you start**
- [ ] Staging URL is on the latest merged SHA
- [ ] `PAWSPACE_PAYMENT_ENV=sandbox` (live payment remains off)
- [ ] Note the exact SHA / URL / date / device (phone + browser)

---

## 1. Customer happy path

1. Open Grooming from the customer app / mobile-app.
2. Select a pet (or create one).
3. Choose **Bath & Basic** (or Essential Bath).
4. Pick a future slot in Bengaluru coverage.
5. Enter / select doorstep address (try assist with `Greenage` if available).
6. Apply coupon if shown; confirm total looks right.
7. Confirm booking (sandbox payment path).
8. Confirm booking appears under My bookings / activity.

**Expected:** booking confirmed, package name matches catalogue, amount matches what you saw at checkout.

**PASS / FAIL:** _____

---

## 2. Partner lifecycle

1. Open Partner app with a **verified provider** session for the assigned groomer.
2. Job appears under Jobs / Home.
3. Accept → On the way → Arrived → Start service.
   - **Only when the booked-time window is switched on** (`PAWSPACE_SERVICE_WINDOW_ENFORCEMENT=on`; always on in
     production): Arrived and Start service are refused more than 60 minutes before or 2 hours after the booked
     start, with a message giving the time in IST. To test straight after booking, sign in as Founder or Manager,
     open **Control → Customer booking lifecycle → Open →** the booking, write a reason (at least 10 characters)
     under **Authorise early/late start** and tap the button. Check the panel shows your sign-in email and the time, then
     retry Arrived (with a fresh GPS fix) and Start service. After any reschedule (even back to the same time),
     authorise it again.
4. Add before + after proof (UAT media path is fine).
5. Complete job.

**Expected:** each step succeeds; completion blocked if proof missing; customer sees completed status. With the
window switched on: Arrived is refused before the authorisation, the panel records who authorised it and when,
and Arrived and Start service succeed after it.

**PASS / FAIL:** _____

---

## 3. Money / invoice / account

1. After capture, payment status is **captured** (sandbox).
2. After complete, invoice / finance projection shows the booking.
3. Create a **new** booking, capture payment, then **cancel** before service.
4. Confirm refund case / refunded payment path in sandbox (no live Razorpay required for synthetic sandbox events).

**Expected:** no double capture; cancel after capture creates a refund case; finance ledger stays consistent.

**PASS / FAIL:** _____

---

## 4. Negative checks

1. Complete without proof → must fail.
2. Different provider session → must not act on the job (403 / not visible).
3. Unsupported pincode / no capacity → no orphan booking/payment.

**PASS / FAIL:** _____

---

## 5. Optional (when sandbox keys are verified live)

Only after you deliberately run against Razorpay **test** mode and Meta/Maps UAT:

- [ ] Razorpay test order → signed webhook → reconciliation
- [ ] Maps route / ETA for an active travel job
- [ ] WhatsApp allowlisted test number delivery

Do **not** enable live Razorpay / production messaging.

---

## Closure

Human UAT closed only when all required rows are PASS with evidence (screenshot + booking IDs).

**Production ready remains FALSE** until controlled pilot + integration verification stages in `docs/INTEGRATION_READINESS_REGISTER.md`.
