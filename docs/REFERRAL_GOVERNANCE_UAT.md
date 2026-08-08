# PawSpace Referral Governance UAT

## Status

**Engineering work in progress. PRODUCTION READY = FALSE.**

This branch replaces the browser/localStorage referral authority and hard-coded referral code with canonical server-owned referral identity, claims and reward ledger mechanics.

## Implemented on this branch

- canonical referral programme table
- customer-bound generated referral codes
- one claim per referred customer/programme
- self-referral rejection
- canonical phone/email overlap hold
- frozen policy snapshot on claim
- first canonical booking qualification
- completed + paid qualification gate
- configured per-referrer monthly reward cap
- immutable reward events
- released reward ledger
- booking-bound UAT reward reservation
- refund/reversal boundary that requires the frozen policy to authorize reversal
- staff fraud/review workflow
- server-owned staff Referral Management control panel
- legacy hard-coded referral commercial path disabled
- explicit UAT/live-money/production-ready boundaries

## Deliberately configuration-required

The seeded UAT referral programme starts **paused** and with these commercial values unset:

- friend discount
- referrer reward amount
- monthly reward limit
- reward validity
- refund/cancellation reversal policy

The programme cannot be activated server-side until those values are explicitly configured. No production reward value is invented by this branch.

## Remaining engineering closure before staff UAT

- explicit `/api/referral-governance` API-gateway permission mapping for customer/staff/Finance actions
- customer booking-flow integration for referral claim identity
- server-authoritative friend-discount binding into canonical booking pricing (current claim response explicitly states `bookingPricingAuthoritative:false`)
- automatic qualification trigger from canonical completed+paid booking lifecycle, or an equivalent idempotent server event consumer
- cancellation/refund event linkage to reward reversal/review after policy approval
- exact-head CI green

## UAT cases

### Programme
- [ ] Seed programme is paused.
- [ ] Activation with missing reward configuration is rejected with `configuration_required`.
- [ ] Authorized pricing manager can save a configured UAT programme.
- [ ] Unauthorized role cannot change programme.

### Code identity
- [ ] Canonical customer receives one stable code per programme.
- [ ] Retry returns same code.
- [ ] No hard-coded employee/customer referral code exists.
- [ ] Non-canonical customer cannot receive a code.

### Claim
- [ ] Customer can claim a valid active programme code.
- [ ] Self-referral denied.
- [ ] Same referred customer cannot claim twice in the programme.
- [ ] Service/city eligibility enforced.
- [ ] Same canonical phone/email creates hold.
- [ ] Retry/idempotency does not create duplicate claim.

### Qualification
- [ ] Non-first booking cannot qualify.
- [ ] Incomplete booking remains pending.
- [ ] Unpaid booking remains pending.
- [ ] Completed + paid first booking qualifies exactly once.
- [ ] Identity hold prevents reward release.
- [ ] Monthly reward limit creates hold rather than over-release.
- [ ] Reward policy snapshot is frozen from claim time.

### Reward wallet
- [ ] Released reward belongs only to referrer.
- [ ] Expired reward cannot reserve.
- [ ] Reward service scope enforced.
- [ ] Same reward cannot reserve twice.
- [ ] Same booking cannot consume/reserve two referral rewards through this ledger.
- [ ] Reservation does not claim authority over canonical booking price until booking integration is completed.

### Reversal
- [ ] Missing/false reversal policy blocks automatic reversal.
- [ ] Approved reversal creates a new negative reward event rather than deleting history.
- [ ] Duplicate reversal is safe.

## Exit rule

This gate becomes **READY FOR STAFF UAT** only after the remaining engineering closure items above are complete and the exact branch head passes the repository CI. Staff UAT evidence is still required before the gate can be called UAT closed.