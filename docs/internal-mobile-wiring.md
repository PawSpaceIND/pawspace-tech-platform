# Internal pre-production wiring

Scope: internal UAT, not production or store distribution. Live payments remain forbidden. Apple/Google signing is not a gate for browser UAT.

## Connected paths

- `/partner-app`: sign in as the assigned grooming provider, select a job, and advance through the existing lifecycle. At arrived/in-service, before/after camera capture is available. Captures register MIME type, size and SHA-256 with `/api/service-media` under the selected booking. No raw photo data is sent to that metadata endpoint.
- Photo capture registers metadata, then sends bytes with the short-lived grant to `/api/internal-service-media`. The internal endpoint verifies owner, token, expiry, byte size, checksum and image signature before a conditional private R2 write. It consumes the grant and places the photo in pending review, never auto-approving it.
- A separate authorised staff reviewer opens `/team/operations/media-review?bookingId=<booking>`, reviews the privately served image and records a manual UAT decision and reason. The uploader cannot self-approve. Return to the partner job and reload proof before completing the service. This is manual internal review, not an automated malware scan.
- `/walker/proof?bookingId=<assigned-booking>&sessionId=<active-session>`: open from the existing walker job list. The live GPS panel checks both lifecycle and proof APIs, matching booking, provider and active session before exposing location controls. Tracking starts only on a user tap. Sample coordinates are clearly sandbox evidence.
- The walking proof page uses safe, actionable error messages rather than rendering raw API errors.

## Verification added

- Executable tests for grooming metadata registration, rejected responses, cross-booking responses, invalid images and active-walk context mismatches.
- Desktop/mobile browser tests for selected booking/session submission and denied access. Added to the supported persona runner. These use mocked API responses to test wiring, not to certify server authorization.
- Release guard parity test now executes the device-side payment guard as well as the Ruby distribution guard, retaining the existing test-quality budget.
- Final local verification: typecheck, build and targeted lint passed; 80 focused mobile/media/UAT tests passed. Private storage was exercised with a real local R2 emulator. Review UI prevents approval before the image loads and resets booking-specific state on navigation.

## Not yet closed

- Internal storage/review wiring is implemented and tested, including a real local R2 emulator write/read and overwrite refusal. A remote internal worker must have the private `PAWSPACE_MEDIA_BUCKET` binding and explicit `APP_ENV=staging`, `PAWSPACE_MEDIA_ENV=uat`, `PAWSPACE_INTERNAL_MEDIA_ENABLED=true`; absent/production settings refuse the endpoint. `.openai/hosting.json` declares the logical R2 binding and local Vite supplies internal flags. No remote resource deployment is implied by these declarations.
- Repository configuration inspection on 2026-09-08 found no `STAGING_R2_BUCKET_NAME` variable. Configure this with an approved private internal bucket before hosted photo UAT. The staging configuration strips the local emulator binding, enables internal media only with that variable, and explicitly pins the production/payment locks. No credentials need to be shared in chat.
- Native packaged entry, device background/offline lifecycle and signed physical builds remain separate native-test work.
- The latest commit still needs remote browser/full-certification results before internal UAT closure. No main merge or distribution trigger is implied by local test success.

Use the existing approved UAT identity/access-code path. Do not weaken authentication, provider ownership, media approval or payment restrictions for internal testing.
