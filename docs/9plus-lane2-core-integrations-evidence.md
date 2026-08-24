# Lane 2 — booking, provider, Maps/GPS, media and KYC: closure evidence

Branch `closure/9plus-lane2-core-integrations`, cut from `main` at
`a95ed7adbbf513ed78e4b88b22afa38ce3b5c940` and synced to
`85ac0c6e275a93d1690428c59aac0b214cdcddf4` (PR #303, grooming commercial truth — a different lane, no
file overlap, merged cleanly).

**No production deployment. No Cloudflare resource created or modified. No live IDfy connection. No
provider identity minted to make a test pass. No secret value or D1 identifier printed, retrieved or
committed.**

---

## 0. The headline: this lane's core module could not be executed by a test at all

`lib/universal-location-recovery.ts` — the module that owns GPS trust, ETA, lateness and provider
recovery — began with:

```ts
export class LocationConfigurationRequired extends Error {
  constructor(public key: string) { super(`configuration_required:${key}`) }
}
```

`constructor(public key: string)` is a **TypeScript parameter property**. It is erasable only by a real
transpiler. Node's `--experimental-strip-types` — the mode *every* suite in this repository runs under —
rejects it at parse time:

```
SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in strip-only mode
```

One token made the entire module unimportable from a test. That is why its existing suite,
`tests/universal-gps-lateness-recovery.test.mjs`, is **nine source-regex assertions**: it reads the file
and checks that the strings `stale`, `low_accuracy` and `invalid_coordinates` appear in it. Every one of
those assertions passed before this branch and still passes. None of them ever ran the function.

It was the only parameter property in `lib/` and `app/` (verified by scan), and it is now an explicit
field assignment. Restoring it takes **13 tests red**, so the unlock is load-bearing rather than
cosmetic.

Executing the module for the first time immediately found two trust gates that never fired for the
inputs that matter — and made the route visible to the repository's authorization sweep, which found a
third defect the moment it could see it.

---

## 1. Defects found by execution, and fixed

### GPS-1 — a capture timestamp in the **future** scored as the freshest possible evidence

`recordLocationEvidence` computed evidence age as:

```ts
const age = Math.max(0, received - captured);
```

A `clientCapturedAt` **ahead** of server time clamps to age `0`. Zero is younger than any freshness
window, so the staleness branch was unreachable for it and the point was stored `trust_state =
"accepted"`.

That matters because `recordEtaSnapshot` refuses to build a customer-facing ETA from anything except an
`accepted` point (`untrusted_location_cannot_drive_eta`). A device with a fast clock — or a client that
simply sends a future timestamp — was the *most* trusted evidence the system could see.

Observed before the fix:

| input | trust before | trust after |
|---|---|---|
| honest, fresh, 10 m | `accepted` | `accepted` |
| genuinely 10 minutes old | `stale` | `stale` |
| genuinely 5000 m accuracy | `low_accuracy` | `low_accuracy` |
| **capture 1 hour in the future** | **`accepted`** | **`stale`** |

**Fix.** Skew is measured in **both** directions against the *same* operator-approved
`eta_freshness_seconds` already on the punctuality policy — `Math.abs(received - captured)`. **No new
tolerance was invented**; the bound in each direction is the number an operator already approved.
The rejection reason distinguishes the two cases (`client_capture_ahead_of_server_time` vs
`client_capture_outside_freshness_window`) so an investigator is not told about lag when the real
problem is a clock. Ordinary drift inside the approved window is still accepted in both directions —
pinned by its own test, so the fix cannot quietly become a rejection of normal devices.

### GPS-2 — an **omitted** accuracy skipped the accuracy policy entirely

```ts
const accuracy = Number(input.accuracyMeters ?? 99999);
```

The `99999` sentinel shows the intent plainly: unknown accuracy should fail the policy. It never
applied. `??` catches only `null`/`undefined`, and the route passes `Number(body.accuracyMeters)`, which
is **`NaN`** when the client omits the field. `NaN > allowed` is `false`, so the low-accuracy branch was
skipped, the point was stored `accepted`, and `accuracy_meters` was written as `NULL` — a position with
no stated accuracy at all, trusted to drive an ETA.

**Fix.** Non-finite accuracy resolves to the fail-closed sentinel the author already chose. This honours
the stated intent rather than introducing a new rule. Reason: `accuracy_not_reported_by_device`.

Both defects are the repository's recurring class — **unknown or absent treated as satisfied**.

### MEDIA-1 — a provider could complete a service with proof they typed themselves

`assertServiceProofRef` accepted any reference of the shape `uat://proof/<bookingId>/<before|after>`
with **no environment gate**:

```ts
if (value.startsWith("uat://proof/")) {
  const expected = `uat://proof/${input.bookingId}/${...}`;
  if (value !== expected) throw ...409;
  return;   // accepted — with no asset, no upload, no checksum, no scan
}
```

Executed against an empty database (`service_media_assets` count **0**), both halves of the grooming
completion mandate were satisfied by two strings composed from the booking id. `grooming-lifecycle`
`complete` requires a before photo, an after photo and a checklist — and then issues an invoice and sets
provider settlement readiness. There is no object store connected (`storageBackend: "not_connected"`),
so this was the *only* proof path that worked, in every environment.

**Fix.** The synthetic path now requires `PAWSPACE_MEDIA_ENV === "uat"` and refuses **403** otherwise.
Registered, scanned, provider-owned media is the only proof path that survives without the flag.

The polarity is deliberately the **opposite** of `PAWSPACE_MAPS_ENV`, and the code says why: for Maps an
absent variable defaults to `"sandbox"`, the *restricted* mode, so absence fails closed. Here the
synthetic branch is the *permissive* one, so absence must refuse — an unset variable in production must
not silently accept fabricated proof.

### MAPS-1 — malformed coordinates were forwarded to the provider

`computeGoogleRoute` validated nothing. Coordinate validation existed only in the `grooming-route`
handler, and there is already a **second** caller — the `location-recovery` `calculate_eta` action,
which reads coordinates back out of the database. `NaN` serialises to `null` in the request body, so the
provider would receive a malformed request instead of a refusal we made on purpose.

**Fix.** `validRoutePoint` is exported and enforced in the adapter. **Not one provider call** is made for
a malformed coordinate — asserted by counting calls against a stubbed transport.

### MAPS-2 — a provider that never answered held the request open

`fetch` was issued with no `AbortSignal`. **Fix.** `MAPS_REQUEST_TIMEOUT_MS = 10_000`, the same ceiling
`DEFAULT_VOICE_TIMEOUT_MS` already uses for outbound media fetches. The test asserts an abort signal is
actually passed — a stub that receives no signal fails the test explicitly, so the assertion cannot pass
vacuously. The JSON parse is also now guarded, so a 200 carrying HTML degrades rather than throwing.

### AUTHZ-1 — the unlock removed the repository's last authorization blind spot, and it found one

`tests/route-authorization-class.test.mjs` sweeps every route and asserts none does work before it
authorizes. It carries an explicit list, `UNLOADABLE_UNDER_STRIP_ONLY`, of routes it **cannot load** —
enumerated rather than pattern-filtered, precisely so a route cannot quietly drop out of authorization
coverage. Its comment already records that `finance-control` and `gst-accounting` sat there until the
same parameter property was removed from `lib/gst-accounting.ts`.

`location-recovery` was **the last remaining entry**, for the parameter property in
`lib/universal-location-recovery.ts`. Removing it made the route loadable, the sweep swept it for the
first time, and it failed immediately:

```
these route/methods newly do work before authorizing: location-recovery.POST
```

`POST` ran `ensureUniversalLocationTables` — ten `CREATE TABLE` statements and an `INSERT` into
`location_control_settings` — **before** any `requirePermission`. The worker gateway does refuse these
callers first, so this is defence-in-depth rather than an open hole, but it is exactly the ordering the
sweep exists to prevent.

**Fix.** Authorization is resolved from a single action→permission map before any work happens. The
per-branch `requirePermission` calls are removed rather than duplicated — two copies of one mapping in
one file is how they drift apart. An unrecognised action now refuses on authorization instead of
answering `400`, so an anonymous caller cannot probe which actions exist.

`UNLOADABLE_UNDER_STRIP_ONLY` is now **empty**, and the comment says to keep it that way: an empty
baseline means the next parameter property to appear fails immediately rather than silently removing a
route — and its module — from authorization coverage. `VALIDATES_BEFORE_AUTHORIZING` was **not**
widened; the new route was fixed instead of being added to the tolerated baseline.

### KYC-1 — the IDfy callback boundary did not exist

`verifyWithIdfy` submits a check and reads whatever the **synchronous** HTTP response carries. Real IDfy
verification is asynchronous: the POST enqueues a task and returns a `request_id`; the outcome arrives
later on a webhook. There was no route, no signature verification, no correlation, and no replay
handling for that webhook. The registry already said so — INT-KYC-01: *"callback correlation,
authentication and replay handling are not implemented or verified."*

The practical consequence: against a live IDfy account an automatable check could only ever settle as
`manual_review` (the tri-state default), so every provider would queue for a human and the one path that
could set `verified` automatically did not exist.

**Implemented** — `lib/idfy-callback-boundary.ts` + `app/api/provider-verification-callback/route.ts`,
deliberately the same shape as the existing telephony callback in `lib/voice-telephony-provider.ts`,
because the threat is identical: an endpoint a provider posts to with no session cookie.

| Property | Mechanism |
|---|---|
| Authentication | HMAC-SHA256 over `` `${timestamp}.${rawBody}` ``, hex, **constant-time** compared |
| Replay (captured body) | freshness window on the timestamp, **absolute** difference so a future stamp is refused too |
| Replay (redelivery) | dedup on the provider's own event id, `UNIQUE` index; answers **200** so the provider stops retrying, and changes nothing |
| Not connected | `IDFY_WEBHOOK_SECRET` absent → **503**, nothing accepted. Deliberately not 401: the caller is not unauthorised, this deployment has no verification channel |
| Correlation | must match a row that is `automated = 1` **and** already carries the `provider_ref` the callback names |
| Cannot create | a callback may only *settle* a check this system submitted |
| Authority separation | refuses **409** on a manual check — police/house/pet-proofing outcomes are a human's recorded judgement |
| Outcome mapping | reuses `mapStatus()` from the submission adapter rather than restating it, so the two channels cannot drift |
| Rejections | recorded, not dropped — a refused callback is evidence too |

The route hands over the **exact received bytes**. Re-serialising a parsed object would change the
string being verified and invite a parse-first-verify-later ordering. `/api/provider-verification-callback`
is gateway-allowlisted alongside the other provider webhooks, and the body is bounded before it is
buffered because the path is reachable with no credential at all.

**Fail-closed interaction that matters:** with IDfy switched off, `runProviderVerification` leaves
`provider_ref` `NULL`. A callback therefore has nothing to correlate to and is refused **404**. The
submission path and the callback path cannot be played off against each other.

---

## 2. Executable evidence

`tests/lane2-core-integration-boundaries.test.mjs` — **64 tests, all executing real modules** against
`node:sqlite` through the repository's D1 shim.

Counts below are enumerated from the file, not from memory. An earlier revision of this table claimed 45
against rows summing to 43; review caught the arithmetic and the enumeration showed the table was the
wrong half — the GPS group held 13 tests, not the 1 + 11 written here, and the media group 9, not 8. No
test was added to make the total agree.

| Group | Tests | What is executed |
|---|---|---|
| GPS evidence trust | 13 | the import that previously threw · accepted / stale / low-accuracy · future capture · in-window skew both directions · omitted accuracy · out-of-range and non-finite coordinates · cross-provider session write · kill switch · untrusted-cannot-drive-ETA · forecast-never-guarantee |
| Maps adapter | 5 | missing key · sandbox lock · malformed coordinates (0 provider calls) · 4xx, 5xx, empty routes, unparseable body, network failure · timeout |
| Service media proof | 9 | accepted registered media · fabricated `uat://` refused · UAT flag path · wrong booking · wrong provider · unscanned/quarantined/revoked/synthetic · purpose reuse · non-PawSpace and traversal-shaped references · missing asset · caller-side mandate for an absent ref |
| IDfy callback | 13 | approved · rejected · ambiguous→review · four forgery attempts · not-connected · stale and future signature · unknown reference · IDfy-off correlation · replay · manual/automated separation both directions · malformed body ordering · missing ids |
| Assignment gating | 4 | partial mandate · full mandate then revocation · host mandate unsatisfiable by automation alone · empty mandate never reads as satisfied |
| Location authorization | 1 | the exported action→permission map, and `requirePermission` ordered before any table creation |
| **PR #305 review remediation** | **19** | the eight findings below, each executed against the defect before it was fixed |
| **Total** | **64** | |

---

## 2a. PR #305 review remediation — eight findings, all validated by execution first

Nine review threads carried eight distinct findings (negative accuracy was reported twice). **Every one
was reproduced by running the code before anything was changed.** None was accepted on description alone
and none was dismissed without counter-evidence.

| # | Finding | Measured before the fix |
|---|---|---|
| 1 | Callback body not bounded while streaming | a chunked body with no content-length delivered **40 MiB in full**, stream never cancelled, *then* 413. And `raw.length` counts UTF-16 units, so 40,000 multibyte characters — **80,000 bytes** — measured 40,000 and passed a 65,536 limit |
| 2 | Nonterminal callback regressed a terminal outcome | a late `in_progress` on a `verified` row wrote `manual_review`; `canTakeAssignments` went **true → false**, revoking a provider who had already passed |
| 3 | A refused callback poisoned its event id | 404, then the retry that should have succeeded returned `{accepted:true, status:200, outcome:"unmatched", duplicate:true}` — the provider stops retrying, the response claims success, and the record stays `manual_review` **forever** |
| 3b | A D1 read failure became an unmatched 404 | `.catch(() => null)` mapped an infrastructure error onto "no such reference" |
| 4 | Signature computed over a re-serialised timestamp | `"…0"`, `"+…"` and a leading zero all pass `Number.isFinite` and then serialise differently — a correctly signed callback 401s and never settles |
| 5/9 | Negative accuracy treated as excellent accuracy | `accuracyMeters: -1` stored **`accepted`** and **drove a configured, customer-facing ETA** |
| 6 | An incomplete 200 stored as a route | `{"routes":[{}]}` → `configured` with distance 0 and **no duration**; `"abc"` → `configured` with distance **NULL** |
| 7 | Timeout swallowed on a stalled body | the request waited the full 10 s and then reported **`"Routes API returned 200"`** |

### How each was fixed

**1.** Reuses `readBoundedRequestText` from `lib/voice-safe-fetch.ts` — already used by the telephony
callback for the same reason. It counts received **bytes** as they arrive and cancels the stream the
moment the limit is crossed. After: 2 MiB read, `cancelled = true`, 413; the multibyte body 413s. A small
multibyte body is still accepted, so the fix is not "refuse anything non-ASCII".

**2.** `TERMINAL_VERIFICATION_STATUSES = ["verified","failed"]` — the two states that represent a
**decision**, both of them existing statuses. A non-decision may never overwrite a decision. Terminal →
terminal still applies in **both** directions: a later revocation and a later correction are the
provider's own judgement, and freezing them would be a different bug. That over-application is itself a
sabotage case. **No new outcome was invented.**

**3.** Two changes that only work together, exactly as review noted. The replay short-circuit keys on
`accepted = 1`, *and* `record()` upserts on `provider_event_id` — because that column is `UNIQUE`,
`INSERT OR IGNORE` would have left the earlier refused row in place and the accepted check would never
match. Proven end to end: refusal 404 → valid retry settles **once** (`duplicate: false`) → the next
delivery is 200 `duplicate: true` **with no further mutation**, and exactly **one** row survives for that
event id, describing the delivery that took effect. **3b:** the `.catch` is gone, so a read failure
throws and the route answers 5xx; a genuinely unknown reference is still 404.

**4.** The HMAC covers `` `${stamp}.${rawBody}` `` — the header **verbatim**. `stampMs` remains, for
freshness only. Tested in both directions: a non-canonical header verifies, and a signature computed over
the normalised form is rejected — so the first test cannot pass by the boundary ignoring the timestamp.

**5/9.** `Number.isFinite(reported) && reported >= 0`. A negative radius is malformed, not excellent.
Reason `accuracy_reported_as_negative`, and the point cannot drive an ETA. **Zero is still accepted** —
unusual but legitimate — so the boundary is pinned on both sides.

**6.** Both measures must be finite and non-negative before a response counts as a route. A complete
route still carries distance and duration through unchanged, and an incomplete answer is now persisted as
`route_unavailable` with a null predicted arrival rather than as `configured`.

**7.** `response.json()` re-throws an `AbortError` so the surrounding handler keeps the timeout message.
Non-abort parse failures still degrade quietly — asserted separately, so the re-throw cannot turn every
malformed body into an exception.

### Remediation sabotage

| Sabotage | Red |
|---|---|
| F1 back to `request.text()` after a length check | 2 |
| F2 monotonic rule removed | 2 |
| F2 rule **over-applied** (freezes terminal states) | 1 |
| F3a replay keyed on event id alone again | 1 |
| F3b `record()` back to `INSERT OR IGNORE` | 1 |
| F3c D1 read failure swallowed to `null` again | 1 |
| F4 timestamp normalised before signing | 2 |
| F5 negative accuracy accepted again | 1 |
| F6 incomplete route accepted as `configured` | 2 |
| F7 `AbortError` swallowed from `response.json()` | 1 |

**No gate was weakened and no review finding was dismissed.** `lib/integration-readiness.ts` remains
untouched, the provider-availability cross-lane blocker remains documented only, and no provider adapter
or external-provider success was invented.

### Sabotage — every fix has a test that dies without it

| Sabotage | Result |
|---|---|
| TypeScript parameter property restored | **13 red** |
| future capture re-clamped to age 0 | **2 red** |
| accuracy back to the `??` sentinel | **1 red** |
| synthetic-proof environment gate removed | **1 red** |
| callback signature verification removed | **1 red** |
| callback replay dedup removed | **1 red** |
| callback signature freshness window removed | **1 red** |
| manual/automated separation removed | **1 red** |
| maps coordinate validation removed | **1 red** |
| maps abort signal removed | **1 red** |
| `location-recovery` table DDL moved back before authorization | **1 red** |
| `location-recovery` per-action gate removed (pre-fix shape) | **1 red** |
| `create_financial_adjustment` downgraded to a booking permission | **1 red** |
| `location-recovery` restored to `UNLOADABLE_UNDER_STRIP_ONLY` | **1 red** (`route-authorization-class`) |

> The DDL-ordering sabotage is caught by this lane's own suite, **not** by `route-authorization-class`.
> That sweep classifies a route by the status it returns, so moving the DDL earlier is invisible to it —
> an anonymous caller still gets 401, just after ten `CREATE TABLE` statements have run. What the sweep
> actually caught was the *pre-fix* shape, where an unrecognised action answered `400` before any
> permission check. Both properties are now pinned, by the suite that can actually see each one.

### A source-regex assertion that broke on a change it should not have noticed

Fixing AUTHZ-1 turned `gate 7` of the legacy GPS suite red. It asserted the literal string
`requirePermission(actor,"finance.manage")` appeared in the route file. The **property** — money
movement needs the finance permission — was still true; it had moved into `LOCATION_ACTION_PERMISSION`
and was now enforced *earlier*. The regex was pinned to a spelling, not a behaviour, so a strict
improvement read as a regression.

It was not weakened to make it pass. `LOCATION_ACTION_PERMISSION` is exported and the new suite asserts
the **actual object the handler indexes**: `create_financial_adjustment → finance.manage`, the three
read actions → `bookings.view`, and that unnamed actions are absent so they fall through to the
strictest permission. It also asserts `requirePermission` appears before `ensureUniversalLocationTables`
in the POST body, which is the ordering property AUTHZ-1 was about.

### A vacuity bug this suite caught in itself

The forgery test's helper read `over.signature ?? await hmac(...)`. Passing `signature: null` to mean
*omit the header* fell through to a freshly computed **valid** signature, so the case labelled "no
signature at all" was testing the exact opposite of its name. It failed, which is how it was found. The
helper now uses `"signature" in over`.

---

## 3. Already-proven scope — cited, not duplicated

These were re-run, not rewritten. Two of them are stronger evidence than a unit test:
`booking-fanout-atomicity-real-d1` spawns a real workerd worker against real D1, and
`scheduling-reservation-leases` drives real route calls through the grooming journey harness.

| Lane requirement | Existing executable evidence |
|---|---|
| identity chain across customer/pet/booking/payment/work-order | `booking-state-integrity`, `canonical-bookings-gateway-authorization` |
| same-count mutations cannot escape reconciliation | `booking-state-integrity` |
| atomic rollback leaves no partial fan-out | `booking-fanout-atomicity-real-d1` (real workerd + D1) |
| duplicate / replayed requests absorbed | `booking-replay-scoping`, `payment-verify-first` |
| city / zone / provider consistency | `canonical-booking-city-zone-integrity`, `city-propagation-closure`, `service-zone-pincode-validation` |
| stale leases release capacity | `scheduling-reservation-leases` (journey harness, real routes) |
| provider unavailability → safe reassignment | `universal-replacement-recovery` via `location-recovery` `select_replacement` |
| provider switch revokes former authority | `uat-provider-switch-gate` (11 tests, merged #272) |
| cross-customer / cross-provider access denied | `boarding-reservation-authority`, `provider-availability-write-ownership`, `uat-scheduling-reservation-ownership-runtime` |
| provider-owned assignment only (GPS) | this suite + `provider-availability-write-ownership` |
| customer-owned booking only | `booking-operations-authorization` |

---

## 4. External providers — status is operational, not engineering

Measured, not assumed. **Presence/absence only — no secret value was read.**

| Integration | Registry | Host reachable | Credentials | Verdict |
|---|---|---|---|---|
| INT-MAPS-01 Google Routes | `production_setup_required` | `routes.googleapis.com` **yes** (host answers) | `GOOGLE_MAPS_SERVER_API_KEY_UAT` **absent** | **READY-BUT-UNCONFIGURED** — adapter sandbox-locked, fail-closed proven; **no provider traffic possible** |
| INT-KYC-01 IDfy | `production_setup_required` | `eve.idfy.com`, `api.idfy.com` **no** (no route) | all four **absent** | **CODE READY, PROVIDER UNAVAILABLE** — submission + callback boundary implemented and executed; **no UAT account** |
| INT-MEDIA-01 private object store | `production_setup_required` | — | — | **NOT IMPLEMENTED — no provider selected** |
| INT-MEDIA-02 malware/content scanner | `production_setup_required` | — | — | **NOT IMPLEMENTED — no provider selected.** `record_scan` is a human-asserted verdict, not a scanner's |

**No adapter was created for any unselected provider, and no provider success was manufactured.** Where
a test drives an adapter it does so against a controlled local transport, and every such test says so in
its own comment. That proves *our* contract under provider failure. It is **not** evidence that Google
Routes or IDfy was ever called.

### Registry changes Lane 4 must integrate

Lane 4 owns `lib/integration-readiness.ts`. **This branch does not touch it.** The one row whose stated
facts this branch changes:

> **INT-KYC-01** — `codeBoundaryStatus: "partial"` → **`"code_ready"`**.
> Current note: *"IDfy request boundary exists; callback correlation, authentication and replay handling
> are not implemented or verified."* Callback correlation, authentication and replay handling **are now
> implemented and executed** (`lib/idfy-callback-boundary.ts`, 13 tests). Suggested replacement: *"IDfy
> request and callback boundaries implemented: signed, correlated, replay-deduplicated, manual/automated
> authority separated. No UAT account connected — provider verification outstanding."*
> `readinessState` **must stay `production_setup_required`**. Nothing here is provider-verified.

A new credential detector is also needed for the callback secret — `IDFY_WEBHOOK_SECRET` — which the
existing `idfy` detector does not cover. Without it the registry cannot tell "callbacks connected" from
"callbacks switched off", and **an unset secret refuses every callback**.

`INT-MAPS-01`, `INT-MEDIA-01` and `INT-MEDIA-02` need no change: their notes are already accurate.

---

## 5. Not delivered — stated plainly

These are the lane's own requirements that this branch does **not** meet. None is claimed at any level.

| Requirement | Status | Exact operational blocker |
|---|---|---|
| **Real Maps provider traffic** for valid requests | **NOT MET** | No `GOOGLE_MAPS_SERVER_API_KEY_UAT`. The host is reachable; without a key no request can be authorised. Needs a Google Cloud project with Routes API enabled and a UAT-restricted server key. |
| **Real IDfy UAT submission + signed callback** | **NOT MET** | No IDfy account, and no route to `eve.idfy.com`/`api.idfy.com` from this environment. Needs a UAT account, `IDFY_API_KEY`/`IDFY_ACCOUNT_ID`/`IDFY_URL`, a callback URL registered with IDfy, and `IDFY_WEBHOOK_SECRET`. The boundary is built and executed against a controlled transport; it has never seen an IDfy payload. |
| **Connected UAT private object store** | **NOT MET** | No provider selected (INT-MEDIA-01). Storage reports `not_connected`. Expiring signed access, retention/deletion and idempotent upload **cannot** be proven without a store, and are **not** asserted. |
| **Connected UAT malware scanner** | **NOT MET** | No provider selected (INT-MEDIA-02). `record_scan` records a human's verdict. Quarantine-on-scan-failure is proven as a *state machine*; it is **not** proven against a scanner. |
| **Android / iOS device matrix** | **NOT MET — not started** | No allow-listed physical devices and no device lab. Permission granted/denied, foreground/background transition and retry-without-duplicate-durable-state **on a real device** are untested. The server-side halves of the same behaviours are executed here. |
| Corrupt-object rejection | **NOT MET** | Requires bytes in a store. MIME, size and checksum-shape rejection are enforced at registration and unchanged. |
| Provider-switch media revocation | **PARTIAL** | Revocation state machine executes; revocation *of objects in a store* cannot be proven without one. |

---

## 6. Score

Scored against **executed** evidence, and deliberately capped where a provider account is missing, per
this lane's own instruction: *never claim IDfy, Maps, media or GPS verified because credentials exist.*

| Dimension | Score | Basis |
|---|---|---|
| Booking / scheduling / capacity / leases / reassignment | **9.0** | Real-D1 worker atomicity, journey-harness leases, executed ownership and replay proofs across merged suites |
| City / zone / pincode consistency | **9.0** | Executed, unchanged this lane |
| Provider onboarding, verification, UAT-only activation | **8.5** | Mandate gating, authority separation and callback boundary executed; **no IDfy account**, so no check has ever been settled by a real provider |
| GPS / lateness / recovery **server-side** | **9.0** | Module made executable; three live defects found and fixed; 11 executed tests; the route now authorizes before it acts |
| Maps | **7.0** | Fail-closed, sandbox-lock, malformed-coordinate refusal and timeout all executed — **zero provider traffic** |
| Media / private storage / scanning | **6.5** | Proof boundary hardened and executed, fabricated-proof path closed; **no store, no scanner** |
| KYC / IDfy | **7.0** | Callback boundary implemented and executed end to end; **never seen a real IDfy payload** |
| **Mobile device verification (Android/iOS)** | **0 — not started** | No devices |
| **Lane 2 overall** | **below 9 — 7.5** | Held down by four missing provider accounts and an untested device matrix, exactly as instructed |

The engineering scope of this lane is at 9 where it is provable. The lane **cannot** reach 9+ overall
from this environment. What is missing is procurement and device access, not code.

---

## 7. Constraints honoured

No production or `pawspace-staging` deployment · no force-push · no reseed · no production migration · no
production data access · no Cloudflare resource created or modified · no branch protection or required
review bypassed · no failed test silently retried · **live IDfy never connected — the external KYC
dependency stayed OFF** · ownership and RBAC not weakened · **no fake provider identity minted** · the
Release UI closure harness untouched · Finance/payroll/CRM/communications, AI, voice, the canonical
readiness registry and deployment workflows all left alone · **no business rule invented** — the GPS
skew bound reuses the operator-approved `eta_freshness_seconds`, and the accuracy sentinel is the one
already in the code.

### Known cross-lane blocker, documented only

`loadGovernedProviders` filters strictly on `starts_at < now` while `setProviderAvailability` stamps
`starts_at = now`, so freshly written availability can be invisible to the very next read. It sits in
`select_replacement`'s path. **Left documented only**, per standing instruction — not touched here.
