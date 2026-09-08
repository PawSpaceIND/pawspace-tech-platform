# Internal pre-production wiring

Scope: internal UAT, not production or store distribution. Live payments remain forbidden. Apple/Google signing is not a gate for browser UAT.

## Connected paths

- `/partner-app`: sign in as the assigned grooming provider, select a job, and advance through the existing lifecycle. At arrived/in-service, before/after camera capture is available. Captures register MIME type, size and SHA-256 with `/api/service-media` under the selected booking. No raw photo data is sent to that metadata endpoint.
- Photo results explicitly say registered, with file upload and independent review pending. A prepared grant is never represented as approved proof. The original photo must be retained. Existing add-proof/completion controls still require the server's approved before/after references.
- `/walker/proof?bookingId=<assigned-booking>&sessionId=<active-session>`: open from the existing walker job list. The live GPS panel checks both lifecycle and proof APIs, matching booking, provider and active session before exposing location controls. Tracking starts only on a user tap. Sample coordinates are clearly sandbox evidence.
- The walking proof page uses safe, actionable error messages rather than rendering raw API errors.

## Verification added

- Executable tests for grooming metadata registration, rejected responses, cross-booking responses, invalid images and active-walk context mismatches.
- Desktop/mobile browser tests for selected booking/session submission and denied access. Added to the supported persona runner. These use mocked API responses to test wiring, not to certify server authorization.
- Release guard parity test now executes the device-side payment guard as well as the Ruby distribution guard, retaining the existing test-quality budget.

## Not yet closed

- Actual private image-byte storage, confirmation and independent review/scanning are not supplied by the current metadata endpoint. This patch does not invent approval, persist photos in an ungoverned store, or call upload completion callbacks after registration.
- Native packaged entry, device background/offline lifecycle and signed physical builds remain separate native-test work.
- The latest commit still needs remote browser/full-certification results before internal UAT closure. No main merge or distribution trigger is implied by local test success.

Use the existing approved UAT identity/access-code path. Do not weaken authentication, provider ownership, media approval or payment restrictions for internal testing.
