# PawSpace Grooming — Launch Candidate Closure

Date: 4 August 2026  
Status: Integration-ready launch candidate

## Outcome

Grooming is now the lead vertical for launch preparation. The customer package, subscription, coupon, scheduling, multi-pet duration, payment-choice, confirmation, provider tracking, photo proof and post-booking journeys are connected to the shared PawSpace test transaction.

The new operating layer adds persistent structured data, controlled workspace identities, configurable role permissions, masked customer contact information, protected CSV import and an Exotel-ready server-routed contact workflow.

## March customer file assessment

Source: `The PawSpace TRUTH - Subscription Customers.csv`

| Check | Result |
|---|---:|
| Rows | 1,304 |
| Customer keys | 1,304 unique |
| Blank phone fields | 25 |
| Historical gross sales | ₹1,84,74,160.21 |
| Grooming orders | 3,126 |
| Grooming subscription orders | 1,968 |

Customer segments: 5 VIP / High Value Repeat, 28 High Value, 264 Loyal Repeat, 58 Multi-Service Cross-Sell, 613 Repeat and 336 One-Time.

Outbound worklist: 398 P1 Personal Call, 591 P2 Call/WhatsApp and 315 P3 WhatsApp customers.

The production source does not contain customer names or phone numbers. The file is imported from the protected Customer Data module into the platform database; each batch records file name, importer, row totals, accepted rows, rejected rows and time.

## Identity and permissions

Default roles:

- Founder — protected owner identity; cannot be downgraded in normal user management.
- Superuser — full operating control except founder protection.
- Admin — customers, bookings, grooming operations, providers, imports and reports.
- Manager — team/city operations with controlled customer access.
- Associate — assigned customer and booking work with masked contact data.
- Service Provider — assigned work and routed call/message actions; no customer number exposure.
- Finance — payment, refund, invoice and reconciliation controls without contact exposure.
- Auditor — read-only reports and audit evidence.

Authorised users can create additional users, assign roles, disable access and adjust role permissions. Full-number viewing, exports, data imports, payments, settings and audit access are independent permissions.

## Contact and Exotel logic

- Customer numbers are masked by default.
- Groomers and other frontline providers call or message through server-side actions.
- The provider chooses Primary or Secondary without seeing the underlying number.
- If the primary contact does not respond, the workflow exposes a controlled secondary-contact fallback.
- Every attempt stores actor, customer, booking when available, channel, target, provider, outcome, reference and timestamp.
- Without Exotel credentials, the experience runs in sandbox mode.
- When `EXOTEL_API_KEY`, `EXOTEL_API_TOKEN` and `EXOTEL_SID` are configured, the same adapter can switch to live routing without redesigning the UI.

## Validation completed

- Customer/source regression: 11/11 passed.
- Backend regression: 20/20 passed.
- Production build: passed.
- Lint: passed.
- D1 schema migration generated and included.
- Agent visual preview could not be opened by the internal review browser; the production build and rendered-route regression were used as the release gate.

## What remains before a real customer launch

1. Import the March CSV while signed in as Founder/Superuser and review the 25 rows without phone numbers.
2. Add the second workspace user and assign the intended role.
3. Confirm final Grooming prices, validity, cancellation, reschedule and refund rules.
4. Complete physical mobile-device UAT for iOS and Android breakpoints.
5. Configure production domain, monitoring, backups, support SOP and incident ownership.
6. Connect integrations in order: payment gateway, OTP/WhatsApp, Exotel, Maps/GPS. Love Leads remains optional because PawSpace has its own CRM.

Until payment and communications integrations are connected, use the controlled manual-operations fallback described in the platform closure plan.
