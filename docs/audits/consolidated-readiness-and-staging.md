# Consolidated readiness and staging evidence

The 95% human-test readiness goal remains unverified. No deployment, production mutation or real message was performed in this pass.

## Current local verification

The complete application suite at `c35ef49d` passed **4,662 tests, zero failures and zero skips** in 338.6 seconds. This consolidates the sandbox-boundary, CX, notification scope/delivery, simulator isolation and audited recovery changes. It is local regression evidence, not a readiness percentage or provider certification.

Subsequently, the staging configuration/certification fix described below passed **70 targeted tests**. Those overlap the full suite and must not be added to its count. JavaScript syntax and diff checks passed; this fix changes deployment tooling/tests, not the built application.

## Staging discovered and checked

The repository's Track 3 workflow identifies `https://pawspace-staging.karthik-fce.workers.dev`. A new read-only probe returned:

- `/healthz`: HTTP 200, `{"status":"ok"}`.
- Anonymous `/api/company-analytics`: HTTP 401.
- Anonymous `/api/communications`: HTTP 401.

The latest successful `deploy-staging.yml` run inspected was [34267236538](https://github.com/PawSpaceIND/pawspace-tech-platform/actions/runs/34267236538), certifying commit `227038d2e0c4f5ad848c76b76207e7fb6dd9aa93`. Its artifact reports six authenticated disposable personas, six staff smoke routes, anonymous refusal and a recorded rollback reference. These are **historical workflow attestations**, not a fresh signed-in test of this audit branch. The minimal health endpoint does not identify a revision.

Remote main still points to `ccfe2ee5720263ae06c0b12648ecc9a7e23cc2ce`. GitHub reports the certified staging commit is **34 commits ahead** of that main baseline. This audit branch has its own local fixes; the two candidates must not be treated as the same build. No branch was overwritten or deployed to replace that staging version.

The separate Sites project ID in `.openai/hosting.json` remains inaccessible (`Sites project not found`). That limitation does not mean the standalone Workers staging URL is down.

## Actual hosted performance gap

[Track 3 run 34184788624](https://github.com/PawSpaceIND/pawspace-tech-platform/actions/runs/34184788624) failed its hosted workload gate. Its artifact reports 10,801 requests, zero errors and aggregate p95 **834.29 ms**, missing its **under-750 ms** threshold. Per-operation p95 includes booking creation **18,755.13 ms**, assignment **9,964.77 ms**, duplicate booking replay **5,024.39 ms**, and ledger reads **785.46 ms**.

This is older-candidate evidence. It is not a benchmark of `c35ef49d` or proof of the current staging latency. It establishes an unresolved performance acceptance requirement; averaging across fast operations must not conceal slow booking creation. The required performance threshold is now known from the workflow, rather than assumed.

## Staging certification defect repaired

A read-only fixture proved that the existing staging isolation preflight accepted `PAWSPACE_PAYMENT_LIVE_APPROVED=true` while `FORBID_PRODUCTION` was absent. The configuration generator also omitted both explicit values. Checking only payment mode and absence of selected voice approval flags was insufficient for the requested beta boundary.

The staging generator now writes the full triplet:

```
PAWSPACE_PAYMENT_ENV=sandbox
PAWSPACE_PAYMENT_LIVE_APPROVED=false
FORBID_PRODUCTION=true
```

Both preflight and certification require exact declared values. Tests reject missing, inverted, uppercase, whitespace-padded and boolean substitutions for the two added string bindings. The normal staging fixture still certifies, and generated artifacts still exclude secrets.

The live staging configuration has not been changed or re-certified with these stricter rules. The historical green certificate cannot prove compliance with checks that it did not contain.

## Next acceptance work

Align the intended audit/release candidate with the newer staged source; run the exact candidate's signed-in golden journeys and real sandbox provider contracts; remeasure booking/assignment and ledger latency against explicit operation budgets; then rehearse release and rollback. Local checks, a health response and historical artifacts do not close those requirements.
