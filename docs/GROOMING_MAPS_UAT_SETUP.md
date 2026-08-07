# Grooming Maps UAT setup

## Scope
This integration is for Grooming UAT only. It does not enable production or background GPS tracking.

Current application behavior:
- Customer doorstep address is persisted against the canonical Grooming booking after booking creation.
- The assigned provider can open Google Maps navigation for the canonical doorstep address.
- Provider GPS is captured only after an explicit `Use my GPS & calculate ETA` action.
- GPS capture is allowed only while the provider work order is `assigned`, `on_the_way` or `arrived`.
- Server-side ETA/distance uses Google Routes API when a UAT key is configured.
- Route snapshots and provider-location events remain booking/provider scoped and audited.
- No Google API key is sent to the Partner browser.

## Google Cloud UAT setup
1. Use a PawSpace Google Cloud project intended for UAT/testing and make sure billing is enabled for Google Maps Platform.
2. Enable **Routes API** only for this first test gate.
3. Create a dedicated server API key for PawSpace Maps UAT.
4. Restrict the key to the **Routes API**. Add an application/IP restriction when the UAT server egress can be restricted reliably.
5. Set a low UAT quota/budget alert before testing.
6. Do not commit or paste the API key into source, GitHub issues, docs or chat.

## Cloudflare UAT runtime
Add these values to the deployed UAT Worker under **Settings -> Variables and Secrets**:

- `PAWSPACE_MAPS_ENV` = `sandbox` (non-secret environment variable)
- `GOOGLE_MAPS_SERVER_API_KEY_UAT` = the restricted Google server key (**Secret**)

Deploy the secret/configuration change after saving it.

## Test sequence
1. Create a Grooming booking with a complete doorstep address.
2. Open the same canonical booking in Partner -> Grooming Bookings.
3. Confirm **Open Google Maps** opens directions to the saved doorstep address. This link works even before the Routes API key is installed.
4. On the provider test device, tap **Use my GPS & calculate ETA** and grant location permission.
5. With the UAT key installed, confirm PawSpace displays Google route distance and ETA and records a route snapshot.
6. Move the booking to `in_service`, `completed` or cancelled and confirm new GPS capture is rejected.
7. Verify another provider identity cannot read or update this booking route.

## Not enabled in this gate
- Background/continuous GPS tracking
- Customer live-map tracking
- Maps JavaScript embedded map
- Places autocomplete
- Production Google Maps credentials
- Cross-service Training/Boarding/Sitting map rollout

Those remain separate controlled gates after Grooming UAT evidence is green.
