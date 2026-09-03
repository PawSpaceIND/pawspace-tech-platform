# Inherited test debt — baseline triage

Working inventory for `fix/inherited-test-debt-baseline`. This branch is scoped to test
scaffolding ONLY: fixtures, harnesses, env declarations and assertions. It must not change
`app/`, `lib/`, `backend/` or `worker/`. If a failure here turns out to need a production fix,
that fix belongs in its own PR, not on this branch — otherwise the "no application logic"
guarantee that makes this branch safe to merge is lost.

## Baseline

Measured on `main` at `101e64b4` (the merge of #440), with the repository's own command:

```
PAWSPACE_LOCAL_PREVIEW=on PAWSPACE_VOICE_TRANSPORT=local_simulator_non_production NODE_ENV=test \
  node --experimental-strip-types --test --test-concurrency=1 tests/*.test.mjs
```

    4033 tests, 3975 pass, 58 fail

These 58 predate #440 and are untouched by it: #440's failure set was verified to be a strict
subset of `main`'s 71 by test name, so nothing here was introduced by that work. 13 of main's
original 71 were fixed by it.

Note the scope is WIDER than "communication fixtures, notification statuses and consent suites".
The single largest cluster is payment webhook verification, and money-hardening is fourth. Any
plan that assumes this is only a comms problem will miss roughly a third of it.

## Failures by suite

      9  ptja-w3a-payment-webhook-verification.test.mjs
      7  communication-enqueue-contract-runtime.test.mjs
      7  customer-reminder-lifecycle-runtime.test.mjs
      7  e2e100-t1-customer-booking.test.mjs
      5  wati-production-readiness.test.mjs
      4  money-hardening.test.mjs
      4  ptja-p1-regressions.test.mjs
      2  grooming-golden-journey.test.mjs
      2  interakt-production-provider.test.mjs
      2  post-service-payment-link.test.mjs
      1  bengaluru-production-remediation-wiring.test.mjs
      1  d1-in-clause-fanout.test.mjs
      1  grooming-payment-reconciliation.test.mjs
      1  grooming-stack-hardening.test.mjs
      1  interakt-whatsapp.test.mjs
      1  loe-remediation-source-contract.test.mjs
      1  payment-provider-contract.test.mjs
      1  staging-activation.test.mjs
      1  whatsapp-template-lifecycle-execution.test.mjs

## Distinct error signatures

    13  Expected values to be strictly equal            (spread across suites; needs per-case work)
     4  PAWSPACE_PAYMENT_ENV must be exactly "sandbox" or "live"; received an unset/empty value
     2  source contract: /if \(!isTrue\(env\?\.PAWSPACE_PAYMENT_LIVE_APPROVED\)\) return \{ ok: false/
     1  source contract: /recordInteraktWebhook/  -> route now calls recordInteraktDeliveryWebhookAtomic
     1  Cannot read properties of undefined (reading 'external_delivery')
     1  these call sites must build IN lists through chunkedIn so they cannot exceed D1's cap
     …  remainder are single consent / reminder-sweep assertions

## Hypotheses already tested and DISPROVED

Recorded so the next person does not spend the time again.

1. **"The suite command is missing `PAWSPACE_PAYMENT_ENV`."** Adding
   `PAWSPACE_PAYMENT_ENV=sandbox` to the shell environment changes nothing: the payment suites
   ran 31/47 with and without it, identically. The routes read `env` from the
   `cloudflare:workers` binding, which `installWorkersHooks` shims from a `globalThis` value —
   a process env var cannot reach it.

2. **"The failing suites set their env global under a name the shim does not read."** This is a
   real bug class and is documented in `tests/helpers/module-hooks.mjs` (the `__FANOUT_ENV__` /
   `__SEED_ENV__` case), but it is NOT the cause here:
   `ptja-w3a-payment-webhook-verification` assigns `globalThis.__W3A_PAY_ENV__` and
   `money-hardening` assigns `globalThis.__MONEY_ENV__`, both matching their own shim. The
   remaining possibilities are the CONTENTS of those env objects, or assignment ordering
   relative to the module import that reads them.

## Two known-cheap items

- `bengaluru-production-remediation-wiring.test.mjs` asserts `/recordInteraktWebhook/` while the
  route now calls `recordInteraktDeliveryWebhookAtomic`. A rename landed without its guard being
  updated; this is a one-line assertion fix, not a defect.
- `wati-production-readiness.test.mjs` (5 failures) may be obsolete outright: PR #392 migrated
  the platform off WATI to the direct Meta WhatsApp Cloud API. Confirm whether the suite should
  be deleted rather than repaired — deleting a suite needs an explicit decision, so it is listed
  here rather than done.

## Out of scope for this branch

The `master-production-audit` check failure is NOT test debt. It is 15 unset repository
secrets/variables (IDfy, R2, provider-agreement e-sign, Meta/Interakt) and is tracked
separately. `scripts/assert-production-readiness.mjs` under `PAWSPACE_PRODUCTION_ENFORCE=true`
produces byte-identical output on this branch and on `main`, so nothing here can affect it.
