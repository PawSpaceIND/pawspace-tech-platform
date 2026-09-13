import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// The worker authorizes every /api/* request by path (lib/api-gateway.ts requiredPermission) BEFORE the
// route runs; an unlisted path needs the default "dashboard.view", which the service_provider role does
// not hold. On staging that made every partner proof upload fail closed at the gateway:
//   POST /api/service-media         -> 201 (grant issued; the path is mapped to bookings.view)
//   PUT  /api/service-media/upload  -> 403 "Permission denied" (unmapped -> dashboard.view)
// so no photo could ever be verified and "Add service proof" stayed refused. Both paths must map to the
// same permission; the upload route itself then enforces provider ownership and the single-use grant.
const gatewaySource = fs.readFileSync("lib/api-gateway.ts", "utf8");
const uploadRoute = fs.readFileSync("app/api/service-media/upload/route.ts", "utf8");
const roles = fs.readFileSync("lib/platform-security.ts", "utf8");

test("gateway: the proof byte-upload path needs bookings.view, exactly like the register path", () => {
  assert.match(gatewaySource, /if\(url\.pathname==="\/api\/service-media"\|\|url\.pathname==="\/api\/service-media\/upload"\)return "bookings\.view";/);
  // The route keeps its own gates behind the gateway: permission, then ownership of the grant's provider.
  assert.match(uploadRoute, /requirePermission\(actor,"bookings\.view"\)/);
  assert.match(uploadRoute, /requireProviderOwnership\(db,actor,grant\.providerId\)/);
});

test("gateway: a partner session holds bookings.view but never the gateway's default dashboard.view", () => {
  const block = roles.match(/code:"service_provider"[\s\S]*?permissions:\[([^\]]*)\]/);
  assert.ok(block, "service_provider role definition present");
  assert.match(block[1], /"bookings\.view"/);
  assert.doesNotMatch(block[1], /"dashboard\.view"/);
  assert.match(gatewaySource, /return "dashboard\.view";\s*\}/, "unlisted /api paths still fall through to dashboard.view");
});
