# Illustrated welcome and location discovery

The existing customer app now starts a fresh browsing session with an illustrated welcome. Three existing theme choices remain: PawSpace Brand, Emerald & Gold, Berry & Sunshine. No new photographic assets were introduced.

Location is requested only after Use my location. It uses one-shot browser geolocation, the existing sandbox reverse-geocoding endpoint, and the existing governed PIN-to-service-coverage endpoint. There is an eight-second geolocation deadline and ten-second network deadlines. Permission denial, unsupported browsers, lookup failure and unavailable coverage offer manual PIN entry and optional browsing without location. Raw provider errors are not rendered. A pending callback cannot override a newer or abandoned choice.

The customer confirms the resolved city/area before continuing. Only the PIN and welcome-seen preference are kept in session storage; coordinates are not stored by this component. A saved PIN is revalidated before showing a city. The PIN prefills AddressPicker, but does not set a verified address or bypass map verification, pricing, scheduling or checkout checks.

## Remaining requirements

- Guest-home city-specific price display is **not implemented**. `/api/catalogue` is staff-authorized, while the existing pricing quote requires a package and scheduled start. Do not expose the staff endpoint or call existing defaults city-specific prices. A governed customer projection of the commercial catalogue and price-validity rules is still required.
- No claim of live geolocation provider success: the deployed sandbox Maps credential/configuration and human permission flow require integration testing. Manual PIN coverage also depends on configured staging coverage.
- Authenticated end-to-end checkout, all partner/CRM screens and device-wide accessibility remain separate QA work.

This is an internal-staging UI/location-discovery change, not production activation.
