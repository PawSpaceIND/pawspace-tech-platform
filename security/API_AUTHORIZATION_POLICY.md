# API authorization policy evidence — issue #201

`lib/api-gateway.ts::requiredPermission()` is the single authoritative route-to-permission registry. The Worker consumes that registry through `authorizeApiRequest()`, while platform identity-session ownership consumes the same decision through `authorizePlatformSessionRequest()` in `lib/session-api-gateway.ts`. Route handlers may add ownership or domain guards, but they do not maintain a second platform route-permission registry.

## Committed matrix

`security/api-authorization-matrix.mjs` is the committed matrix view. It regenerates every first-level `app/api/*/route.ts` exported HTTP method and records:

- route and exported HTTP method;
- the authoritative gateway decision and all permission/public outcomes present in that route's gateway clause;
- customer/provider ownership requirements from canonical route guards and the platform-session scope layer;
- route/session/Worker enforcement layers and any direct route permission guards;
- whether the method is state-changing.

Run `node --experimental-strip-types security/api-authorization-matrix.mjs` to print the current JSON matrix. The CI test imports the same committed module, so the matrix is regenerated on every `npm test` without introducing a copied permission map.

## Drift gate

`security/api-authorization-policy-baseline.json` pins the reviewed `app/api` tree and the five authorization source blobs. Any route source/method/ownership edit, gateway policy edit, session-scope edit, ownership primitive edit, permission primitive edit, or Worker authorization edit fails CI until the baseline is deliberately reviewed and updated. The gate also asserts that `requiredPermission` has exactly one production definition and that the Worker/session path consumes it.

The baseline's `reviewedHead` records the commit whose policy inputs were reviewed; it is evidence, not a requirement that future commits retain that HEAD SHA.

## Negative authorization coverage

`tests/api-authorization-negative.test.mjs` executes the production authorization primitives extracted from the exact TypeScript sources. For every generated protected route/method it checks unauthenticated, forged-header, and under-privileged denial at the authoritative gateway layer. For every matrix row classified as customer/provider-owned it checks the corresponding route ownership primitive and/or platform-session subject guard rejects a cross-subject actor.

Known public-read/write decisions remain policy, not test invention. The earlier #201 public-write blockers are pinned explicitly: `GET /api/training-requirements` and `GET /api/host-trust` remain public while their writes are protected. `GET /api/canonical-bookings` remains `bookings.view`. No permission is changed by this evidence gate.
