# PawSpace Platform API

The platform core now includes an Integration Gateway so every PawSpace channel can use the same governed adapters for MongoDB, OTP, WhatsApp/SMS/email, push, Razorpay, RazorpayX and maps. It defaults to deterministic sandbox adapters: no real customer message, charge, payout or location request is sent until authorised credentials are configured.

## Integration controls

- `GET /v1/integrations/health` — connector readiness without exposing secrets
- `POST /v1/integrations/test` — super-admin sandbox tests for OTP, payments, payouts and maps
- `POST /v1/notifications/process` — retry-aware outbox delivery with partial-channel preservation
- `POST /v1/webhooks/razorpay` — HMAC-verified payment events
- `POST /v1/webhooks/communication` — HMAC-verified communication receipts
- `GET /v1/maps/route-quote` — vendor-neutral route estimate contract

Copy `.env.example` to `.env` for local configuration. Blank connector credentials intentionally keep that adapter in sandbox mode.

The central source-of-truth API for the customer app, provider app, CRM, Sales/Ops, finance and reports.

## Current milestone

- Customer search and Customer 360 with role-based number masking
- Customer and pet creation with legacy MongoDB ID preservation
- City-specific service catalogue and prices
- Live availability capacity model
- Idempotent booking creation to prevent duplicates
- Full-time automatic assignment and commission-provider offer logic
- Subscription creation and multi-session planning
- Booking status workflow and immutable audit events
- Operations/finance overview reporting
- In-memory development repository and production MongoDB repository
- HMAC-signed, expiring sessions for production API access
- Provider availability and full-time/commission assignment decisions
- Reliable multi-channel notification outbox with retry state
- Privacy-safe MongoDB legacy-data analyser with duplicate detection
- Prepaid and pay-after-service payment ledger with duplicate protection
- GST-inclusive invoice calculation and one-invoice-per-booking control
- Controlled full and partial refunds
- Provider cash collection and finance reconciliation
- Five-day cooling ledger and idempotent RazorpayX-ready payouts
- Hashed, expiring, single-use OTP challenges with rate limits
- Customer channel, consent, quiet-hour and reminder preferences
- 15-day care, subscription renewal, payment recovery and app-adoption journeys
- Automated service-recovery tickets with 30-minute SLA routing
- Shared service catalogue for grooming, training, boarding, sitting, walking, taxi and fresh food

## Local validation

```bash
npm install
npm run typecheck
npm test
```

The default repository is in-memory and requires no credentials. For a controlled MongoDB environment, configure the values from `.env.example` through a secret manager and set `DATABASE_DRIVER=mongodb`.

## Production connection rule

Do not paste MongoDB credentials into chat, source code or screenshots. Before connecting production data, PawSpace should provide a read-only schema/sample export and create a short-lived, IP-restricted migration credential through its database administrator.
