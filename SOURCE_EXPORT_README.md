# PawSpace Tech Platform — Current Source Export

This archive is a source-only export of the current deployed PawSpace Grooming Site. It preserves the deployed Customer, Partner, Team, and Control experiences without redesign or simplification.

## Export provenance

- Site: `PawSpace Grooming`
- Current deployed Site version: `67`
- Source commit: `21cdff1509e7939b31dad760d24a2d6317504d01`
- Commit title: `Consolidate PawSpace into four role-based experiences`
- Export prepared: 7 August 2026
- Deployment changed by this export: **No**

The source commit above matches the source provenance recorded for deployed Site version 67. Dependency folders, generated build output, local caches, runtime logs, Git history, and secrets are intentionally excluded. Reproducible dependency lockfiles are included.

## 1. Project structure

| Path | Purpose |
| --- | --- |
| `app/` | Vinext/Next-compatible web application, all customer and staff routes, API routes, styles, and reusable UI components. |
| `app/page.tsx`, `app/mobile-app/`, `app/account/` | Customer front doors, booking journeys, account, activity, subscription, payment, tracking, and support views. |
| `app/partner/`, `app/partner-app/` | Consolidated Partner front door and partner work-order experience. Specialist groomer, trainer, host, walker, and driver routes are also preserved. |
| `app/team/` | Consolidated Team experience for Sales, CRM, Customer Experience, Operations, Finance, Marketing, and People. |
| `app/control/` | Consolidated Control experience for launch readiness, security/RBAC, integrations, pricing, scheduling, subscriptions, finance, marketing, audit, and governance. |
| `app/booking-command-center/` | Modern Booking Command Center UI. |
| `app/crm/`, `app/ops/`, `app/admin/` | CRM, Revenue & CX engine, Ops, Admin, and supporting operating views preserved from the current build. |
| `app/api/` | Hosted API routes for canonical bookings, booking operations, CRM, Revenue 100, finance, scheduling, governance, subscriptions, customer contact, and system integration. |
| `lib/` | Shared booking/test transaction engine, lifecycle clients, pricing and offer engines, auth/RBAC helpers, security model, fixture data, and regression utilities. |
| `db/` | D1/SQLite connection and Drizzle schema used by the hosted application. |
| `drizzle/` | Complete ordered SQL migration history (`0000` through `0016`). |
| `backend/src/` | Standalone Fastify platform API: domain models, assignment, subscriptions, payments/invoices/refunds, finance, CRM automation, auth, notifications, integrations, repository, and scheduling. |
| `backend/test/` | Standalone backend workflow and regression tests. |
| `mobile/` | Expo/React Native customer application source and configuration. |
| `tests/` | Hosted application regression tests. |
| `public/` | PawSpace logo, stay/provider images, favicon, and other required public assets. |
| `build/`, `worker/`, `scripts/` | Sites/Vite/Cloudflare build, validation, Worker, install, and deployment-support source. |
| `docs/` | Architecture, 4 August closure audit, full platform audit, and grooming launch-candidate records. |
| `.openai/hosting.json` | Current Sites project binding declaration. It contains no runtime secret. Use a new project identity when deploying a separate copy. |

Primary routes include `/`, `/mobile-app`, `/account`, `/partner`, `/team`, `/control`, `/booking-command-center`, `/crm`, `/ops`, `/admin`, `/system-integration`, and the service/provider routes retained under `app/`.

## 2. Install

### Prerequisites

- Node.js `>=22.13.0`
- npm matching the supplied lockfiles
- Linux is recommended for the root bounded install/build helpers (`flock` and GNU `timeout` are used)

### Hosted web application

```bash
npm ci
```

### Standalone platform API

```bash
cd backend
npm ci
cp .env.example .env
```

Blank integration values keep the API in deterministic sandbox mode.

### Expo mobile application

```bash
cd mobile
npm ci
```

## 3. Run locally

### Hosted web application

From the archive root:

```bash
npm run dev
```

The Vinext development runtime simulates the declared D1 binding. Local privileged API access uses the development-preview actor defined in `lib/server-auth.ts`.

### Standalone platform API

In a second terminal:

```bash
cd backend
npm run dev
```

The API defaults to the in-memory repository. Set `DATABASE_DRIVER=mongodb` only for an authorised controlled environment with a real `MONGODB_URI` supplied outside source control.

### Expo mobile application

```bash
cd mobile
npm start
```

Use Expo Go for local device testing. Native production store configuration is not included because it is not live yet.

## 4. Run tests

### Hosted web application

```bash
npm test
npm run lint
npm run validate:artifact
```

`npm test` builds the deployable artifact and runs the rendered HTML regression suite.

### Standalone platform API

```bash
cd backend
npm run typecheck
npm test
```

### Expo mobile type check

```bash
cd mobile
npx tsc --noEmit
```

## 5. Mock and test data

The export is the current UAT implementation, not a production-data export.

- `lib/pawspace-test-data.ts` contains synthetic PawSpace customers, pets, bookings, subscriptions, transactions, provider activity, and operating fixtures.
- `lib/test-transaction.ts` and the test-sync surfaces provide the browser-side synthetic booking/transaction ledger used by prototype journeys.
- `lib/regression-suite.ts`, `app/regression-lab/`, and `app/test-lab/` contain UAT/regression fixtures and utilities.
- Several customer, provider, CRM, Admin, Ops, Finance, HR, Marketing, and reporting screens still combine persistent UAT records with static fixture arrays or demonstration actions.
- The standalone API defaults to `MemoryRepository`; its test files use deterministic synthetic records.
- D1 migrations and schema are real application code, but any deployed UAT database contents are not included in this source-only archive.
- No production customer database dump, uploaded customer media, payment record export, or runtime environment value is included.

## 6. Integrations not yet live

The current source includes governed adapters, queue records, consent/template checks, retries, webhook contracts, and readiness indicators. The following still require secure production configuration and controlled end-to-end testing:

- WATI/WhatsApp credentials, approved templates, delivery receipts, and opt-out validation
- SMS gateway credentials, sender ID, templates, and delivery webhooks
- Exotel telephony credentials and masked-call/live-call routing
- Production scheduler for automatic 7 PM reports and background 30/60/90-day lead reopening
- Customer/staff/provider production identity and OTP providers
- Razorpay payment/refund webhooks and RazorpayX payout/reconciliation setup
- Production MongoDB/canonical persistence migration and reconciliation
- Maps, geocoding, routing, ETA, geofencing, and time-bounded live location
- Email, push notifications, secure media upload/scanning/retention, accounting export, observability, alerting, backup, and restore

Without these credentials, communication, payment, refund, payout, location, and scheduled automation paths remain sandboxed, queued, manually triggered, or represented as UAT records. Never place real credentials in this archive; copy `.env.example` files locally and inject secrets through an approved secret manager/runtime.

## 7. Known gaps from the 4 August 2026 closure audit

The original audit is included verbatim at `docs/closure-audit-2026-08-04.md`; the wider audit is at `docs/full-platform-audit-2026-08-04.md`. Later source revisions added the Revenue & CX engine, Booking Command Center, integration control, and the four front doors, but those additions do not by themselves close the following production-readiness findings:

### Canonical data and workflows

- Some journeys and screens still use browser-local synthetic state, fixture tables, or demonstration actions instead of one server-backed booking/event aggregate.
- The hosted D1 API routes and the standalone Fastify platform API remain separate implementation layers; a production cutover and reconciliation contract is still required.
- Full catalogue/price validation, subscription concurrency protection, real provider availability/capacity, acceptance expiry/rerouting, support/reschedule/cancellation/refund execution, and cross-surface projections require production validation.
- Training session objects and Boarding/Sitting Meet & Greet, home-access, incident, and caregiver-payout flows remain incomplete for live operations.

### Security and access

- The Site is workspace-restricted, but every page route is not independently server-gated by role; privileged API routes implement RBAC and must remain the enforcement boundary.
- Field-level permissions, record-ownership coverage, consistent masking/reveal approval, immutable/tamper-evident audit retention, secure home-access handling, session/device revocation, CSRF, rate limiting, upload scanning, webhook replay protection, and secret rotation require production review.
- Development header identity and in-memory/browser records must never be treated as trusted production evidence.

### Mobile, quality, and operations

- Real-device QA remains required across iOS Safari, Android Chrome, tablets, safe areas, keyboard/focus, text scaling, accessibility, landscape, and 320–1024 px viewport coverage.
- Full end-to-end, multi-browser/device, offline/retry, idempotency, backup/restore, rollback, performance, observability, and incident-response testing remains outstanding.
- Specialist provider pages and the consolidated Partner experience still overlap and need final production role routing.

### Launch gate

The audit sequence remains: freeze versioned rules, complete canonical projections and regression coverage, connect APIs in sandbox, rehearse migration/reconciliation, add integrations one at a time, run employee and invited-customer pilots, then launch one Bengaluru zone under controlled approval.

## Environment and secret handling

- Root `.env.example` documents hosted-app runtime placeholders.
- `backend/.env.example` documents standalone API placeholders.
- Test-only strings in test files and sandbox fallback strings are not production credentials.
- Runtime secrets, API keys, passwords, access tokens, private keys, production database values, and deployed database contents are intentionally absent.

