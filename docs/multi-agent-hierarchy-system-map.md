# PawSpace Multi-Agent Hierarchy — Foundational System Map

```text
Founders / Cockpit
      ^
      | human escalation only
      |
Atlas CEO Supervisor
  |-- target pacing ---> Sales Manager / existing AI sales dispatcher
  |-- capacity conflict -> Sales: halt Grooming in affected zone; pivot to Training/Boarding
  |-- recovery mandate -> Ops Manager
  `-- lifecycle mandate -> Marketing Manager

Ops Manager
  `-- provider.recover (canonical tool boundary)
        `-- existing scheduling / capacity / verification / recovery mutations
             `-- communication-engine -> WhatsApp outbox

Marketing Manager
  |-- completed canonical bookings (read-only query)
  |-- communication-engine -> WhatsApp outbox
  `-- outbound_routing_queue -> Exotel / voice dispatcher

Human Escalation Router
  |-- safety / injury
  |-- payout or refund batch above operational threshold
  |-- prolonged gateway outage
  `-- provider-capacity exhaustion requiring hiring
```

## Invariant
Agents own reasoning, prioritization, and routing. They do not directly rewrite booking assignment, payment, payout, refund, or communication delivery state. Physical execution remains behind existing deterministic/canonical mutation tools and outboxes.
