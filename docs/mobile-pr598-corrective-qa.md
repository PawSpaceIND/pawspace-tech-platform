# PR #598 corrective QA — 2026-09-08

Base reviewed: `a0950912d11d371db39daf3e6209bec271076416`.

## Corrected in this patch

- Reject missing, empty, and malformed payment isolation configuration; explicit configuration cannot silently inherit safe defaults.
- Retain unacknowledged offline records after repeated failures; conflicts are not delivery acknowledgments.
- Serialize queue mutations and share in-flight flushes within one JavaScript runtime so concurrent captures are not overwritten.
- Surface device-storage failures rather than claiming a durable save.
- Stop treating grooming/GPS 404 and 409 responses as successful submissions. Queued photos do not invoke uploaded callbacks; queued GPS packets are not counted as sent.
- Replace camera/GPS error payloads with bounded, actionable customer-facing copy.
- Handle network initialization, synchronization and teardown promise failures; distinguish partial synchronization from completion.
- Remove unverified payment-safety assurances from recovery boundaries and update the corresponding browser assertion.
- Correct the GPS auto-start effect lint error without disabling lint rules.

## Local evidence

- `npm run typecheck`: passed.
- `npm run build`: passed, producing a Worker/web artifact, not a native app bundle.
- `npm run lint`: passed with 82 pre-existing warnings and zero errors.
- Internal UAT Gate A: 5/5 passed.
- Mobile native ecosystem suite: 15/15 passed. Many checks inspect source strings; this is not device certification.
- New executable mobile release regressions: 4/4 passed (invalid locks, repeated conflicts, concurrent enqueue/flush, storage quota failure).
- Desktop/Pixel browser resilience run attempted: browser launch was blocked by the host sandbox (`bootstrap_check_in ... Permission denied`). No browser test reached its assertions. Must rerun in CI/a permitted browser host.
- Test commands explicitly supplied sandbox/true/false isolation flags. This does not certify hosted environment variables or credentials.

## Release remains blocked

1. Both Capacitor configurations point to `.next`; the verified web build does not produce `.next/index.html`. A packaged mobile entry and correct API/auth boundary are needed. Do not substitute a dummy page or silently turn this into a remote-only wrapper.
2. `GroomingUpload` sends data URLs to `/api/service-media`, whose contract instead requires MIME type, size and checksum, followed by a signed upload, confirmation and separate review. The route explicitly reports `adapterConnected:false`. A 201 prepares a grant; it is not an uploaded/approved photo. Storage/scanner integration must preserve ownership and maker/checker controls.
3. Neither `GroomingUpload` nor `ActiveWalkMap` is mounted by an application route. Authorized booking/session context must be wired before claiming these user journeys work. Do not use the components' sample IDs for real bookings.
4. The beta workflow triggers on manual dispatch or version tags, not a protected merge to main. Adding automatic distribution requires a verified packaging path and successful required checks for the exact commit first.
5. Partner lanes still build native projects with hardcoded customer application identifiers. Selecting a Fastlane lane does not switch these identities. iOS archive configuration also references an `.xcworkspace` while this checkout contains an SPM-based project. Verify the actual signed build target before upload.
6. The iOS lane passes a raw `.p8` path as `api_key_path`; Fastlane key configuration and signing need validation before distribution.
7. Offline queue changes protect one runtime only. Account-scoped storage, concurrent browser-tab coordination, photo-specific replay/acknowledgment, persistent upload completion notifications and native background behavior still need integration QA.

No protected merge, tag, distribution dispatch, signing change, production-payment enablement or live deployment was performed by this patch.
