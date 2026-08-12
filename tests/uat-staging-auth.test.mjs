import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const lib = await read("../lib/uat-staging-auth.ts");
const auth = await read("../lib/server-auth.ts");
const route = await read("../app/api/staging-login/route.ts");
const cfg = await read("../scripts/stage-config.mjs");

test("UAT sign-in is production-safe: flag-gated and dead unless enabled", () => {
  assert.match(lib, /PAWSPACE_UAT_LOGIN.*==="on".*PAWSPACE_UAT_SIGNING_KEY/s);
  assert.match(lib, /if\(!uatLoginEnabled\(env\)\)return null/);       // resolve is a no-op when disabled
  assert.match(lib, /crypto\.subtle\.sign\("HMAC"/);                    // signed cookie
  // resolveActor wires it in AFTER dev-preview, gated
  assert.match(auth, /resolveUatStaffActor/);
  assert.match(auth, /a no-op in production where PAWSPACE_UAT_LOGIN is unset/);
});

test("stage-config turns UAT login ON for staging only, with an access code + signing key", () => {
  assert.match(cfg, /PAWSPACE_UAT_LOGIN: "on"/);
  assert.match(cfg, /PAWSPACE_UAT_ACCESS_CODE/);
  assert.match(cfg, /PAWSPACE_UAT_SIGNING_KEY/);
});

test("the login route requires the access code and only works when enabled", () => {
  assert.match(route, /uatLoginEnabled/);
  assert.match(route, /uatAccessCodeValid/);
  assert.match(route, /Invalid access code/);
  assert.match(route, /clearUatCookie/);                                // logout
});

test("the API gateway allowlists the login endpoint and honours the UAT cookie", async () => {
  const gw = await read("../lib/api-gateway.ts");
  assert.match(gw, /pathname==="\/api\/staging-login"/);    // login endpoint is allowlisted (public)
  assert.match(gw, /resolveUatStaffActor\(env\.DB,request/); // gateway resolves the UAT cookie
  assert.match(gw, /a no-op in production/);
});
