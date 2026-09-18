# PawSpace V2 rebuild foundation

This document locks the first implementation boundary for the PawSpace V2 rebuild.

## Entry point

- V2 customer foundation route: `/v2`
- Branch: `feat/pawspace-v2-foundation-20260916`
- V1 remains untouched while V2 is proven slice by slice.

## Non-negotiable architecture rules

1. **Backend truth is reused, UI state is rebuilt.** V2 consumes the existing authoritative identity, customer-account, availability, booking, scheduling, payment and governance engines. It does not fork them.
2. **No business policy in presentation components.** Prices, capacity, payment state, provider eligibility and service availability must come from governed backend contracts.
3. **One client boundary.** V2 route components consume `lib/v2/*` clients. Direct scattered fetches from presentation components are prohibited.
4. **No legacy UI imports.** V2 may link to a proven V1 journey during migration, but it must not import legacy screen components or legacy CSS into the V2 experience.
5. **Fail closed on availability.** If service availability cannot be verified, V2 shows the service but does not present it as bookable.
6. **One design system direction.** Emerald `#062F27`, gold `#E7B24C`, ivory/cream surfaces, editorial typography, joyful pet imagery and restrained motion form the base. Customer delight is layered on top without changing operational truth.
7. **No fake success.** A card, metric, booking state or AI statement must be backed by actual account/system data or clearly presented as guidance.

## First vertical slice delivered by this foundation

`/v2` now reads live data from:

- `/api/identity-session`
- `/api/customer-account`
- `/api/service-availability`
- `/api/customer-otp`

The home experience renders the signed-in family, saved places, booking history, next-care summary and service availability from those authoritative APIs. OTP uses the existing governed identity path and the current environment's sandbox/live delivery policy.

## Migration order

1. V2 foundation: shell, auth, family/account truth, availability, responsive design.
2. V2 Grooming: canonical catalogue -> serviceability -> capacity -> provider choice -> hold -> payment -> confirmation.
3. V2 Activity: canonical booking projection, status, proof, support and recovery.
4. V2 Partner: one selected job, next required action, offline-safe proof and lifecycle.
5. V2 Operations/CRM: governed read models only; no sample-data tabs promoted as live.
6. Additional customer verticals: Training, Boarding, Sitting, Walking, Food, Relocation and Taxi according to launch scope.

## Definition of done for each V2 journey

A journey closes only after its backend contract, executable domain test, UI implementation, browser E2E, staging proof, failure/recovery behavior and required device evidence are all tied to the same candidate SHA.
