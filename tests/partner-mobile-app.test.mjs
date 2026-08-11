import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("keeps the provider Partner app mobile-first and canonical", async () => {
  const [page, routeCard, api, layout, styles] = await Promise.all([
    "app/partner-app/page.tsx",
    "app/partner-app/grooming-route-card.tsx",
    "app/api/grooming-route/route.ts",
    "app/partner-app/layout.tsx",
    "app/partner-app/partner.module.css",
  ].map((path) => readFile(new URL("../" + path, import.meta.url), "utf8")));

  assert.match(page, /PAWSPACE PARTNER MOBILE/);
  for (const label of ["Home", "Jobs", "GPS", "Earnings", "More"]) assert.match(page, new RegExp(`\\"${label}\\"`));
  assert.match(page, /\/api\/identity-session/);
  assert.match(page, /\/api\/partner-grooming-jobs/);
  assert.match(page, /GroomingRouteCard/);
  assert.match(page, /Settlement-controlled earnings/);
  assert.match(page, /Live money/);
  assert.match(page, /OFF/);
  assert.match(page, /background GPS/i);

  assert.match(routeCard, /watchPosition/);
  assert.match(routeCard, /Start GPS/);
  assert.match(routeCard, /Stop GPS/);
  assert.match(routeCard, /foreground-only/i);
  assert.match(routeCard, /clearWatch/);
  assert.match(routeCard, /\/api\/grooming-route/);

  assert.match(api, /requireProviderOwnership/);
  assert.match(api, /activeTravelStates/);
  assert.match(api, /provider_location_events/);
  assert.match(api, /GPS capture is disabled outside assigned, on-the-way or arrived states/);

  assert.match(layout, /PARTNER MOBILE UAT/);
  assert.match(layout, /Live payouts, background GPS and production activation remain disabled/);
  assert.match(styles, /max-width:560px/);
  assert.match(styles, /bottomNav/);
  assert.match(styles, /grid-template-columns:repeat\(5,1fr\)/);
});
