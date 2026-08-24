# PawSpace Total Journey Audit (PTJA) — master test, audit and fix plan

**Status: PLAN ONLY. Nothing in this document has been executed.**

One purpose: take the whole platform from "each lane says it is closed" to "a human can start business UAT",
by finding every business-logic, flow, identity and automation defect that survives the current gates, fixing
them, and proving each fix with executed evidence.

---

## 0. Why this plan is shaped the way it is

Five facts about this repository, measured, not assumed. They dictate the design.

| Measured fact | Consequence for the plan |
|---|---|
| **52% of suites (161/309) are `source_contract`** — they read source text and assert strings appear | Grep-backed passes are not evidence. Every agent must *execute*. |
| **40 suites claim a verdict (`gate`, `closure`, `truth`) while only reading source** | These are the highest-yield hunting ground. A named gate that never ran is where defects live. |
| **`hosted_provider` evidence = 0 suites, repository-wide** | No external provider has *ever* been exercised. Nothing here can change that; the plan must stay honest about it. |
| **The recurring defect class is "unknown or absent treated as satisfied"** — found repeatedly in GPS accuracy, capture time, media proof, route metrics, credential detection | Every agent gets an explicit *absent-value probe* obligation. |
| **One TypeScript token made a whole module unimportable**, so its only "evidence" was grep | Loadability is a first-class check, not an assumption. |

The plan therefore optimises for **execution, adversarial verification, and non-vacuity** — not for test count.

---

## 1. The Identity Spine — how "every test datum touches everything" becomes checkable

The instruction *"every test data has to touch base everything"* is only meaningful if a single identity is
threaded through every module and then **reconciled**. That is the spine.

### 1.1 Spine dataset (seeded once, shared by every agent, read-only)

```
3 cities            Bengaluru · Chennai · Hyderabad        (multi-city, zone, pincode)
2 customers/city    = 6 customers                          (each originates from a LEAD)
2 pets/customer     = 12 pets                              (1 fully vaccinated, 1 not — gates must bite)
1 lead/customer     = 6 leads                              (lead → conversion → customer link)
≥1 booking per customer in EVERY service vertical
   grooming · training · boarding · sitting · walking · taxi · food · relocation
every payment state represented across the set
   created · captured · failed · partially_refunded · refunded · split/deposit · expired link
every provider category represented
   groomer · sitter · trainer · host · walker · driver
commercial objects attached to the SAME identities
   coupon · referral · subscription · wallet · paw points · plan upgrade
AI / chat / voice conversations attached to the SAME customer + booking
reports, intelligence, P&L computed over exactly this set
```

### 1.2 The spine invariant

```
lead_id → customer_id → pet_id → booking_id → payment_id → work_order_id
        → media/proof → invoice_id → journal_id → settlement_id → report_row
```

**Any module that forks, drops, re-mints or silently substitutes a link in this chain is a defect**, regardless
of whether its own tests pass. This single invariant catches the class of bug that per-module testing
structurally cannot see.

### 1.3 Reconciliation obligations (the part that finds business-logic defects)

Every number must agree across the surfaces that report it, computed independently:

| Quantity | Must agree between |
|---|---|
| Booked / collected / refunded / net | booking · payment · invoice · journal · Finance panel · P&L · report |
| Bookings per city | scheduling · city governance · ops dashboard · intelligence |
| Provider utilisation | capacity governance · work orders · settlement · partner report |
| Lead → booking conversion | funnel · CRM · marketing attribution · revenue report |
| Tax/GST | invoice lines · tax ledger · GST package · annual return |
| Wallet / points liability | ledger · customer balance · Finance liability line |

A disagreement is a **P1 by default** — it means at least one surface is lying to a human.

---

## 2. Fleet design — agents, waves, and what each owns

Parallelism is the point, but **uncontrolled parallelism produces merge chaos** (this repository has already
seen repeated concurrent-push collisions). So: *find* in wide parallel, *fix* in ownership-partitioned waves.

### Wave 0 — Ground truth (1 agent, blocking)

Produces the contract every later agent reads. Nothing starts until this lands.

- Freeze the exact base SHA; record it.
- Run the evidence-class audit → module × evidence-class matrix, and the current list of verdict-claiming
  source-contract suites.
- Enumerate **every** route, every scheduled job, every webhook receiver, every background worker.
- Enumerate every environment gate and record, for each, **which direction absence falls**.
- Emit `PTJA-BASELINE.json`: routes, jobs, gates, suites-by-class, module owners, file-ownership map.

### Wave 1 — Spine construction (2 agents, blocking)

- **1A Spine builder** — deterministic seeder producing §1.1 against an isolated DB. No randomness, no
  `Date.now()` drift; one anchored clock.
- **1B Spine integrity** — asserts §1.2 end to end and publishes the reconciliation harness of §1.3 for
  everyone else to call.

### Wave 2 — Domain sweeps (18 agents, fully parallel, read-only)

Each agent: drive the **real routes/modules** over the spine, hunt, and file findings. **No fixes in this wave.**

| # | Agent | Owns |
|---|---|---|
| 1 | Lead generation & funnel | capture, dedup, attribution, consent, lead→customer conversion |
| 2 | Customer booking (all verticals) | quote → book → pay → confirm, per vertical, per city |
| 3 | Journey & lifecycle | state machines, allowed/forbidden transitions, terminal states, proof mandates |
| 4 | Scheduling & capacity | reservations, leases, expiry, double-book, travel buffer, reassignment |
| 5 | Multi-city / zone / pincode | city binding, cross-city relabelling, zone coverage, serviceability |
| 6 | Provider onboarding & KYC | application → verification mandate → activation → assignment eligibility |
| 7 | Payments | gateway, links, capture, refund ceilings, idempotency, replay, expiry |
| 8 | Finance & accounts | ledger balance, invoice, GST, payroll, settlement, period lock, close |
| 9 | Marketing & commercial | coupons, referrals, subscriptions, wallet, points, expiry, stacking |
| 10 | CRM & communications | templates, consent, allow-list, retry/backoff, dead-letter, delivery callbacks |
| 11 | AI orchestrator | tools, approval gates, high-impact refusal, handoff precedence, grounding |
| 12 | Chat surface | session identity, cross-customer leakage, transcript integrity |
| 13 | Audio/voice bot | state machine, policy gate, idempotent dial, opt-out, recording consent |
| 14 | Reports & intelligence | every figure sourced from records; unsourced reads "Not connected", never `0` |
| 15 | Partners & vendors | partner identity, commission, payout readiness, statement reconciliation |
| 16 | Automation | crons, schedulers, background jobs — fire-once, catch-up, overlap, failure isolation |
| 17 | Identity, RBAC & authorization | every route: authorize-before-work, ownership vs authority, staff bypass |
| 18 | Media, storage & proof | upload → scan → access → retention → revocation → proof linkage |

**Cross-cutting agents, running alongside:**

| Agent | Owns |
|---|---|
| **X1 Evidence-class auditor** | reclassifies every suite; a finding "proved" by grep is rejected |
| **X2 Vacuity enforcer** | audits the *tests*: does each assertion die when its subject breaks? |
| **X3 Reconciliation** | runs §1.3 continuously as other agents mutate the spine |
| **X4 Ownership arbiter** | maps every proposed fix to a file owner; prevents Wave-4 collisions |

### Wave 3 — Adversarial verification (3 verifiers per finding, parallel)

Every finding gets **three independent verifiers with different lenses**, each instructed to *refute* it:

- **Correctness** — is the described behaviour actually what the code does?
- **Reachability** — can a real actor reach it, with the permissions they actually hold?
- **Consequence** — if real, does anything downstream actually suffer?

**A finding survives only on ≥2 of 3 confirmations.** Refuted findings are recorded with their counter-evidence
— a disproved suspicion is evidence too, and stops the next agent re-filing it.

### Wave 4 — Fix waves (partitioned, sequential *between* partitions, parallel *within*)

X4 partitions confirmed findings by file ownership. Partitions run one at a time; agents inside a partition
run in parallel because they cannot touch the same file.

Suggested partition order (lowest coupling first):
1. Leaf verticals & surfaces
2. Marketing / commercial objects
3. Payments & Finance
4. AI / chat / voice
5. Scheduling & capacity core *(highest coupling — last, single agent)*
6. Identity / RBAC / gateway *(touches everything — single agent, own partition)*

### Wave 5 — Convergence

Full suite · typecheck · lint against baseline · build · artifact · exact-head CI · spine re-run · full
reconciliation · evidence-class re-audit (the `source_contract` share **must** have fallen).

### Wave 6 — Human UAT pack

Scripted journeys with expected/actual columns, per role, per city, per vertical — filled in by the human, not
pre-filled.

---

## 3. Rules every agent obeys (non-negotiable)

These exist because each one has already caught a real defect — or a real *false* defect — in this codebase.

1. **Execute, never grep.** A finding backed only by source text does not exist. If the module cannot be
   imported, *that is finding #1* — file it and unblock it.
2. **Reproduce before fixing.** Record the measured before-value verbatim. "Looks wrong" is not a finding.
3. **Sabotage every fix.** Revert the fix; the new test must go red. Record the count. A fix with no red is
   not proven.
4. **Add a non-vacuity counter-test.** Prove the fix did not over-apply — the honest case must still pass.
   (A negative-accuracy fix must still accept zero; a byte-limit fix must still accept a small multibyte body.)
5. **Probe the absent value explicitly.** For every input: absent, `null`, `undefined`, `NaN`, `""`, `false`,
   `[]`, `{}`, negative, future-dated, wrong type. This *is* the house defect class.
6. **Check gate polarity.** For every environment flag: if it is unset, does the system become more permissive
   or less? Permissive-on-absence is a defect regardless of intent.
7. **Never invent a business rule.** Unknown product semantics go to the **Decision Ledger** for a human. Do
   not pick a number, a threshold, or a policy.
8. **Never manufacture provider success.** No fake adapters, no fake credentials, no stubbed 200 presented as
   provider evidence. A stubbed transport proves *our* contract and must say so in the test itself.
9. **Never weaken a gate to go green.** If an existing assertion reddens, ask whether it pinned a *spelling* or
   a *property*. Fix the property; re-point the assertion. Adding to an allow-list is a last resort that must be
   justified in writing.
10. **Report blocked as blocked.** Do not raise a score because adapter code exists.
11. **Determinism.** One anchored clock per suite. No `Date.now()` twice inside one assertion. Isolated DB per
    agent.
12. **Own your lane.** A fix outside your partition becomes a filed finding for its owner, never an edit.

---

## 4. High-yield hunt list (start here — each is a pattern already found in this codebase)

| # | Pattern | Where it hides |
|---|---|---|
| H1 | Module unloadable by the test runner → only grep "evidence" | TS parameter properties; missing loader hooks |
| H2 | `??` does not catch `NaN`; `Number()` used as a validator | any numeric input from a request body |
| H3 | Client-supplied timestamp trusted without an upper bound | GPS capture, webhook signatures, event ordering |
| H4 | Idempotency key not binding the full mutation context | coupons, referrals, payments, wallet, food |
| H5 | Read → decide → write race on a state machine | async provider callbacks, concurrent staff actions |
| H6 | Unbounded body on an unauthenticated endpoint | every webhook receiver |
| H7 | Outbound call with no timeout / no body deadline | every provider adapter |
| H8 | Work performed before authorization | every route with `ensure*Tables` |
| H9 | A status/registry row that can be *talked into* "ready" | readiness registry, activation checklists |
| H10 | Synthetic/UAT bypass with no environment gate | proof references, test-mode shortcuts |
| H11 | Terminal state regressed by a late or out-of-order event | verification, booking lifecycle, payment |
| H12 | A displayed figure that is a constant, not a computation | dashboards, intelligence, P&L |
| H13 | Ownership mistaken for authority (owner can lift a staff restriction) | provider/customer self-service |
| H14 | Cross-tenant read/write via an id in the body | every `*-by-id` route |
| H15 | Automation that double-fires, or silently never fires | crons, schedulers, retries |

---

## 5. Finding schema (every agent emits this — machine-mergeable)

```json
{
  "id": "PTJA-0001",
  "agent": "07-payments",
  "module": "payments",
  "touchpoint": "refund",
  "severity": "P0|P1|P2|P3",
  "class": "business-logic|identity|automation|authorization|reconciliation|data-integrity|surface-truth",
  "spine_object": "BKG-BLR-GROOM-001",
  "reproduction": "exact executable steps",
  "measured_before": "verbatim observed value",
  "expected": "why that is wrong, and against which rule",
  "rule_source": "existing code intent | approved policy | invariant §1.2 | NONE -> decision ledger",
  "consequence": "what a customer / provider / accountant actually experiences",
  "verifiers": { "correctness": "confirmed", "reachability": "confirmed", "consequence": "refuted" },
  "verdict": "CONFIRMED|REFUTED",
  "owner_partition": "3-payments-finance",
  "fix": { "commit": null, "regression_test": null, "sabotage_red_count": null, "non_vacuity_test": null },
  "external_blocker": false
}
```

### Severity

| | Meaning |
|---|---|
| **P0** | Money wrong, identity crossed, authorization bypassed, or a human is shown a false number they will act on |
| **P1** | Business rule violated; journey completes with wrong state; reconciliation disagrees |
| **P2** | Degrades safely but wrongly; recoverable; no bad durable state |
| **P3** | Cosmetic, naming, or evidence-quality only |

---

## 6. Exit criteria — when human UAT may start

**Engineering gates (this plan can satisfy all of them):**

- [ ] Spine invariant §1.2 holds end to end, executed
- [ ] Every reconciliation in §1.3 agrees, executed
- [ ] Zero CONFIRMED P0; zero CONFIRMED P1 without an accepted, written deferral
- [ ] Every fix has a regression test **and** a recorded sabotage red count **and** a non-vacuity counter-test
- [ ] `source_contract` share materially reduced; **zero** verdict-claiming source-contract suites remain
- [ ] Every module loadable and executed — no grep-only module
- [ ] Full suite green · typecheck clean · lint at baseline · build + artifact · exact-head CI green
- [ ] Decision Ledger empty or every entry explicitly ruled by a human
- [ ] Human UAT pack written, with blank Actual columns

**Operational gates (this plan CANNOT satisfy — they need procurement, not code):**

- [ ] Google Routes credentials
- [ ] IDfy UAT account **+ webhook secret**
- [ ] Private object storage selected and configured
- [ ] Malware scanner selected and configured
- [ ] Payment provider sandbox credentials + webhook secret
- [ ] Communications provider (WhatsApp/SMS/email) credentials, senders, templates
- [ ] AI provider key · Telephony (Exotel) credentials · STT · TTS
- [ ] Allow-listed Android and iOS devices

> **These two lists must never be merged into one score.** Engineering closure and operational readiness are
> different axes; the second is currently `hosted_provider = 0` across the entire repository.

---

## 7. Orchestration mechanics

- **Scale:** Wave 2 is ~22 concurrent agents; Wave 3 is 3 × (findings). Budget accordingly.
- **Isolation:** every agent gets its own database and its own worktree. No shared mutable state except the
  read-only spine snapshot.
- **Determinism:** one anchored clock; no randomness; agents vary by index, not by chance.
- **Merge safety:** Wave 4 partitions are sequential. Before every push: fetch, merge (never force-push), re-run
  the partition suite.
- **Loop-until-dry:** Wave 2 repeats until two consecutive rounds surface no new findings — a fixed round count
  misses the tail.
- **Dedup:** against *all findings ever seen*, not against confirmed ones only, or refuted findings re-enter
  every round and the loop never converges.
- **No silent caps:** if any agent bounds its own coverage (top-N, sampling, skipped vertical), it must say so
  in its report. Silent truncation reads as full coverage.

---

## 8. Deliverables

1. `PTJA-BASELINE.json` — ground truth at the frozen SHA
2. `PTJA-FINDINGS.json` — every finding, confirmed and refuted, with verifier votes
3. `PTJA-DECISIONS.md` — Decision Ledger: product questions no agent may answer
4. Fix commits — one partition per PR, each with regression + sabotage + non-vacuity evidence
5. `PTJA-RECONCILIATION.md` — every number, every surface, agreed or explained
6. `PTJA-EVIDENCE-DELTA.md` — evidence-class before/after
7. `PTJA-HUMAN-UAT-PACK.md` — the scripted journeys a human runs
8. `PTJA-BLOCKER-MATRIX.md` — engineering vs operational, never collapsed

---

## 9. Honest limits of this plan

- It cannot exercise any external provider. `hosted_provider` evidence will still be **0** at the end unless
  credentials arrive. Every provider-facing test proves *our* contract against a controlled transport, and must
  say so in its own text.
- It cannot certify Android or iOS behaviour. Permission grant/denial, background transition and on-device
  retry are OS behaviours no server-side suite observes.
- It cannot decide product policy. Where a rule does not exist, the plan produces a **question**, not a number.
- It will not raise any readiness score on the strength of adapter code existing.
- The cross-lane provider-availability blocker (`starts_at <` strict vs `<=` inclusive, fail-open) is currently
  **unowned**; this plan files it to an owner rather than silently adopting it.
