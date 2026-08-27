/**
 * Every governed policy domain must actually be reachable in the Control Center.
 *
 * MEASURED. lib/service-policy-governance.ts keeps its domains in a module-level Map that each domain
 * fills by calling registerServicePolicyDomain at import time. app/api/service-policy-control/route.ts
 * imports the kernel and nothing else, so in a worker that has not otherwise touched a domain module the
 * Map is EMPTY: GET /api/service-policy-control answered {"domains":[]} and POST answered "Unknown policy
 * domain <name>" 400 for every one of them. Nine approved policies - the refund ladder, the city status
 * matrix, the verification mandate, the masking matrix, the quiet-hours reasons, the media upload
 * boundary - were unreachable from the surface built to change them, and the Control Center panel
 * listed nothing.
 *
 * It passed every existing test because each domain suite imports its own domain module before calling
 * the route, which registers it as a side effect. The route was never exercised cold.
 *
 * This is the audit's own recurring defect wearing a different hat: an empty registry read as "there
 * are no policies" instead of "the policies have not been loaded". The fix is an explicit barrel the
 * route imports, and this suite pins that every registering module is in it. [PTJA-W2-B4-M04]
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_REG_DB__", "__PTJA_REG_ENV__");

const stub = { prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }) }) }), batch: async () => [], exec: async () => ({}) };

async function registeringModules() {
  const files = (await readdir(new URL("../lib", import.meta.url))).filter((name) => name.endsWith(".ts"));
  const found = [];
  for (const name of files) {
    const source = await readFile(new URL(`../lib/${name}`, import.meta.url), "utf8");
    if (/registerServicePolicyDomain(<|\()/.test(source) && name !== "service-policy-governance.ts") found.push(name);
  }
  return found;
}

test("the Control Center route sees every registered policy domain, cold", async () => {
  globalThis.__PTJA_REG_DB__ = stub;
  globalThis.__PTJA_REG_ENV__ = {};
  const governance = await import("../lib/service-policy-governance.ts");
  await import("../app/api/service-policy-control/route.ts");
  const visible = governance.servicePolicyDomains().map((entry) => entry.domain).sort();
  const expected = (await registeringModules()).length;
  assert.ok(visible.length >= expected,
    `${expected} lib modules register a policy domain but the Control Center route sees ${visible.length}: ${JSON.stringify(visible)}`);
  for (const domain of ["media_upload"]) {
    assert.ok(visible.includes(domain), `${domain} must be reachable in the Control Center: ${JSON.stringify(visible)}`);
  }
});

test("every module that registers a domain is in the barrel the route imports", async () => {
  const barrel = await readFile(new URL("../lib/service-policy-domains.ts", import.meta.url), "utf8");
  const missing = (await registeringModules()).filter((name) => !barrel.includes(name.replace(/\.ts$/, "")));
  assert.deepEqual(missing, [],
    "these domain modules register a policy nobody can reach from the Control Center — add them to lib/service-policy-domains.ts");
});

test("the route imports the barrel rather than the kernel alone", async () => {
  const route = await readFile(new URL("../app/api/service-policy-control/route.ts", import.meta.url), "utf8");
  assert.match(route, /service-policy-domains/,
    "app/api/service-policy-control/route.ts must import the domain barrel, or its registry is empty in a cold worker");
});
