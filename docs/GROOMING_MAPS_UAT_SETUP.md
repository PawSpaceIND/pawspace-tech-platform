# Grooming Maps UAT setup

## Scope
This integration is for Grooming UAT only. It does not enable production Maps credentials or unrestricted background tracking.

Current application behavior:
- Customer doorstep address and coordinates are persisted against the canonical Grooming booking.
- The assigned provider can open Google Maps navigation for the canonical doorstep address.
- Provider GPS is ingested only through the governed provider tracking path and is accepted only for the assigned provider / booking lifecycle.
- Server-side ETA and distance use Google Routes API when the UAT key is configured.
- Trusted provider fixes are stored in `universal_provider_location_events`; ETA snapshots are booking/provider scoped and audited.
- The customer Grooming card polls roughly every 5 seconds.
- When the booking is in a customer-visible tracking status and has a fresh trusted GPS fix + fresh configured ETA, the customer card renders a Google Static Maps image with:
  - `P` = privacy-rounded provider position (3 decimal places)
  - `H` = canonical doorstep destination
- Raw provider coordinates, accuracy, and evidence ids are not returned in the customer JSON.
- Google API keys are never sent to the Partner or Customer browser.

## Customer live-map contract
The customer map endpoint is:

`GET /api/customer-grooming-summary?bookingId=<bookingId>&map=1`

It is authenticated and customer-owned.

The live map is available only when the customer tracking projection is `live`.

Customer-visible booking statuses are:
- `on_the_way`
- `arrived`
- `in_service`

Terminal booking statuses immediately return tracking state `ended`:
- `completed`
- `cancelled`
- `refunded`
- `failed`

The map response fails closed:
- `409` — tracking is not live or required trusted/destination coordinates are unavailable
- `503` — Google Maps server key is not configured
- `502` — Google Static Maps request failed or timed out

## Google Cloud UAT setup
1. Use a PawSpace Google Cloud project intended for UAT/testing.
2. Enable billing for Google Maps Platform.
3. Enable **Routes API** for ETA/distance.
4. Enable **Maps Static API** for the customer live-map image.
5. Keep the UAT key(s) restricted to only the required APIs.
6. Prefer separate credentials for server-side Routes and Maps Static when moving beyond this UAT gate so each key can use the strongest compatible restriction model.
7. Set low UAT quotas and budget alerts before testing.
8. Do not commit or paste API keys into source, GitHub issues, docs, screenshots, or chat.

Current PawSpace UAT code reads one server-side secret:
- `GOOGLE_MAPS_SERVER_API_KEY_UAT`

Do not tighten application restrictions on that shared key without testing both Routes and Maps Static from the deployed Cloudflare Worker. A restriction that works for one API may break the other.

## Cloudflare UAT runtime
Add these values to the deployed UAT Worker under **Settings -> Variables and Secrets**:

- `PAWSPACE_MAPS_ENV=sandbox` (non-secret environment variable; used by the Routes adapter)
- `GOOGLE_MAPS_SERVER_API_KEY_UAT` = restricted Google Maps UAT server key (**Secret**)

Deploy the configuration change after saving it.

## End-to-end test sequence
1. Create a Grooming booking with a complete, geocoded doorstep address (latitude + longitude present).
2. Open the same canonical booking in Partner -> Grooming Bookings.
3. Confirm **Open Google Maps** opens directions to the saved doorstep address.
4. Provider accepts the booking and starts the journey.
5. On the provider test device, allow location access and send a governed GPS fix.
6. Confirm the GPS fix is stored as an accepted trusted provider event for the correct booking/provider.
7. Confirm Google Routes produces fresh distance + ETA and stores a route/ETA snapshot.
8. Open the same booking as the owning customer.
9. Confirm the customer summary reports `tracking.state = "live"`.
10. Confirm the customer card shows:
   - Google map image
   - provider marker `P`
   - doorstep marker `H`
   - ETA
   - distance
11. Move the provider and send a newer accepted GPS fix.
12. Confirm the customer card refreshes and the map changes on the normal ~5-second polling cycle.
13. Confirm another customer cannot load the booking summary/map.
14. Confirm another provider cannot read or update the booking route.
15. Complete/cancel the booking and confirm customer tracking becomes `ended` and the live map is no longer served.

## Privacy and safety requirements
- Never expose raw provider latitude/longitude in the normal customer JSON.
- Never expose provider GPS accuracy or evidence ids to the customer.
- Keep Google credentials server-side.
- Use the latest trusted provider fix only.
- Provider position in the customer Static Map is rounded to 3 decimal places.
- Do not extend customer location sharing beyond the governed booking lifecycle.

## Not enabled by this gate
- Google Maps JavaScript interactive map
- Uber-style continuously animated marker
- unrestricted/background tracking outside the governed provider tracking path
- production Google Maps credentials
- cross-service Training / Boarding / Sitting customer live-map rollout

These remain separate controlled gates after Grooming live-map UAT evidence is green.
