# PTJA execution plan, sized to the real budget window

## The constraint, measured not guessed

Session budget resets on a **5-hour cycle at :50 past the hour** — observed resets at 04:50, 09:50 and
14:50 UTC. Eleven subagents have been killed mid-probe across four of those boundaries.

What the failures taught, in order of usefulness:

| Observation | Rule it produces |
|---|---|
| 4 parallel agents burned a whole window in ~1 hour | **Never more than 2 agents at once.** The concurrency cap is 2 anyway — launching 4 only queues them so they all die together. |
| Every agent that wrote incrementally kept its findings; every agent that batched its write lost everything | **Write output after EVERY finding**, not at the end. Non-negotiable in the preamble. |
| Agents launched mid-window died before reporting | **Launch agents in the first 30 minutes of a window**, never later. |
| Work killed mid-fix leaves a dirty tree and an unclear state | **Stop starting new work at T-60m.** The last hour is for closing only. |
| Context can be summarised away mid-task | **This plan lives in the repo**, not in conversation. |

## The shape of one window (5h)

```
T+0:00 → T+0:30   Launch at most 2 sweep agents for the next dark domains.
T+0:30 → T+3:30   Sequential fix cycles. Each: regression red → smallest fix → focused rerun
                  → full suite → commit → push. One commit per defect, always.
T+3:30 → T+4:00   Collect agent findings, update the ledger, commit it.
T+4:00 → T+5:00   CLOSE: full repository suite, typecheck, lint, build, artifact, Release CI,
                  push. Start nothing new.
```

A fix cycle costs ~20-25 minutes, so a window closes **6-8 defects**. That is the planning unit.

## Why fixing is never delegated

All 23 fixes this audit has landed were done directly, sequentially. Agents are read-only by design and
have a 69% death rate at window boundaries. They are excellent at **breadth** — 22 findings from one
Batch A, including 11 P0s — and useless at closure. So: **agents sweep, the lead fixes.**

## Remaining work, in windows

**Window A — Payments & Finance money P0s** (this window)
Cross-customer order settlement · refused-event replay granting entitlement · refund webhook attributing
to the newest case · closed-period writes · GST structurally zero. No new agents: Batch A already
delivered more findings than a window can fix.

**Window B — Identity & Marketing, sweep Partners + Reports**
Launch 2 agents (partners/payouts, reports/intelligence) at T+0. Fix the four cross-tenant reads and the
wallet/points ceiling while they run.

**Window C — Fix Batch B, sweep CRM + Media**
**Window D — Fix Batch C, sweep AI/chat/voice + Automation**
**Window E — P2/P3 backlog, final gates, the three readiness decisions**

## Definition of done, since "95% bug-free" has no denominator

We cannot count unknown bugs, so we do not claim a percentage. What is claimed instead, and evidenced:

1. All 18 planned domains swept with **executed** proof, never grep.
2. Every P0 and high-risk P1 reproduced independently before a line changed, and locked by a permanent
   regression that fails if the fix is reverted.
3. Every finding not fixed carries a written reason naming the product, policy or deployment decision it
   waits on.
4. Gates green at the exact head: full suite, typecheck, lint, build, artifact, Release CI.
