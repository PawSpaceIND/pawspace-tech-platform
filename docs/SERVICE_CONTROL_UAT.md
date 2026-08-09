# PawSpace service availability control

The Control Center now owns a persisted, audited switch for each current customer service family: Grooming, Training, Boarding, Pet Sitting, Pet Taxi, Dog Walking, Pet Food, Pet Relocation, and Funeral & Memorial.

All services are seeded **enabled**. Founder/Admin/Manager users with the existing launch-management authority can disable or re-enable a service from **Control Center → Launch essentials → Services**. A disable requires a clear reason and every state change is stored in the service-control audit ledger as well as the Control Center launch audit.

## Runtime boundary

A disabled service stops new customer entry at the platform boundary. The gate covers new commercial quote requests for Training, Boarding, Pet Sitting, Pet Taxi, Dog Walking and Food; new canonical scheduling reservations for all six scheduled service codes including Grooming; new Food orders and Food subscription creation; and new Relocation or Funeral & Memorial cases.

Existing scheduling requests are allowed to retry idempotently, and existing Food orders are allowed to retry by idempotency key. The switch deliberately does not block existing booking/case lifecycle actions, support, refunds, operational work, finance, reconciliation or administrative closure. This prevents a service pause from stranding customers already in flight.

## UAT checks

1. Open Control Center → Launch essentials → Services and confirm all nine services initially show Enabled.
2. Disable one service and enter a reason of at least eight characters.
3. Confirm a new request for that service returns HTTP 503 with `SERVICE_DISABLED` while other enabled services continue normally.
4. Confirm existing lifecycle, support/refund and finance actions for the disabled service remain available.
5. Re-enable the service and confirm new customer requests are accepted again.

This is an engineering/UAT control. It does not by itself declare the PawSpace platform production-ready.
