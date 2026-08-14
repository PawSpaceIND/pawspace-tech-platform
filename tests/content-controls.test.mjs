import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";
import { createD1 } from "./helpers/d1.mjs";

// Test-only resolve hooks: "cloudflare:workers" resolves to a stub whose env.DB is the current
// per-test SQLite-backed D1 shim, so the REAL route and lib execute unmodified.
const CF_STUB = "data:text/javascript,export const env={get DB(){return globalThis.__CC_DB__;},get FOUNDER_EMAIL(){return undefined;},get PAWSPACE_UAT_LOGIN(){return undefined;}};";
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: CF_STUB, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: ${JSON.stringify(CF_STUB)}, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

// batch() is one transaction in D1: see tests/helpers/d1.mjs. The loop this replaced committed
// each statement as it went, so any atomicity claim below was measured against the wrong machine.
const makeD1 = (sqlite, options) => createD1(sqlite, options);

let sqlite;
function freshDb() { sqlite = new DatabaseSync(":memory:"); globalThis.__CC_DB__ = makeD1(sqlite); }

const route = await import("../app/api/content-controls/route.ts");
const { saveContentBlock, setContentBlockStatus, setFeatureControl, featureEnabled, publicContent } = await import("../lib/content-controls.ts");

async function parseBody(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { error: text }; }
}
const call = async (method, bodyOrQuery, headers = {}) => {
  const url = `http://localhost/api/content-controls${method === "GET" && bodyOrQuery ? `?${bodyOrQuery}` : ""}`;
  const request = method === "GET"
    ? new Request(url, { headers })
    : new Request(url, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(bodyOrQuery) });
  const response = await (method === "GET" ? route.GET(request) : route.POST(request));
  return { status: response.status, body: await parseBody(response) };
};
// Non-preview customer identity: role customer has neither marketing.manage nor settings.manage.
const callAs = async (method, bodyOrQuery, email) => {
  const url = `https://app.pawspace.test/api/content-controls${method === "GET" && bodyOrQuery ? `?${bodyOrQuery}` : ""}`;
  const headers = { "content-type": "application/json", "oai-authenticated-user-email": email };
  const request = method === "GET" ? new Request(url, { headers }) : new Request(url, { method, headers, body: JSON.stringify(bodyOrQuery) });
  const response = await (method === "GET" ? route.GET(request) : route.POST(request));
  return { status: response.status, body: await parseBody(response) };
};

const NOW = Date.now();
const DAY = 86_400_000;
function seedCustomerIdentity(email) {
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)").run(`usr-${email}`, email, email.split("@")[0], "customer", NOW, NOW);
}
async function publishedBlock(db, overrides = {}) {
  const saved = await saveContentBlock(db, { title: "Monsoon grooming care", bodyMd: "Keep coats dry and book indoor slots.", placement: "home_banner", actorId: "marketing:uat", ...overrides });
  await setContentBlockStatus(db, { blockId: saved.blockId, status: "published", actorId: "marketing:uat" });
  return saved;
}

// ---- 1. The leak pin: public read serves published, in-window content ONLY ------------------------

test("real execution: drafts, archived blocks and out-of-window copy can never leak to the public read", async () => {
  freshDb();
  const db = globalThis.__CC_DB__;
  const draft = await saveContentBlock(db, { title: "Unfinished draft copy", bodyMd: "Not ready for customers yet.", placement: "home_banner", actorId: "m" });
  const live = await publishedBlock(db);
  const archived = await publishedBlock(db, { title: "Old campaign banner" });
  await setContentBlockStatus(db, { blockId: archived.blockId, status: "archived", actorId: "m" });
  const expired = await publishedBlock(db, { title: "Expired offer copy", validUntil: NOW - DAY });
  const future = await publishedBlock(db, { title: "Diwali teaser", validFrom: NOW + 7 * DAY });
  const scheduled = await publishedBlock(db, { title: "Live windowed banner", validFrom: NOW - DAY, validUntil: NOW + DAY });
  const view = await publicContent(db, { placement: "home_banner" });
  const ids = view.blocks.map(block => block.id);
  assert.ok(ids.includes(live.blockId), "published unwindowed copy is visible");
  assert.ok(ids.includes(scheduled.blockId), "published in-window copy is visible");
  assert.ok(!ids.includes(draft.blockId), "drafts must never leak");
  assert.ok(!ids.includes(archived.blockId), "archived copy must never leak");
  assert.ok(!ids.includes(expired.blockId), "expired copy must never leak");
  assert.ok(!ids.includes(future.blockId), "future-scheduled copy must never leak early");
  assert.equal(view.blocks.length, 2);
});

test("real execution: city and service scoping narrow the public read; global blocks reach everyone", async () => {
  freshDb();
  const db = globalThis.__CC_DB__;
  const global = await publishedBlock(db, { title: "Platform-wide announcement", placement: "announcement" });
  const blrOnly = await publishedBlock(db, { title: "Bengaluru-only banner", placement: "announcement", cityId: "blr" });
  const groomingOnly = await publishedBlock(db, { title: "Grooming page copy", placement: "announcement", serviceCode: "grooming" });
  const blr = await publicContent(db, { placement: "announcement", cityId: "blr", serviceCode: "grooming" });
  assert.deepEqual(blr.blocks.map(block => block.id).sort(), [global.blockId, blrOnly.blockId, groomingOnly.blockId].sort());
  const pune = await publicContent(db, { placement: "announcement", cityId: "pune" });
  assert.deepEqual(pune.blocks.map(block => block.id), [global.blockId], "another city sees only the global block");
});

// ---- 2. Versioning + governance --------------------------------------------------------------------

test("real execution: editing a published block bumps its version; archived blocks are final; validation holds", async () => {
  freshDb();
  const db = globalThis.__CC_DB__;
  await assert.rejects(saveContentBlock(db, { title: "Valid title", bodyMd: "Valid body copy", placement: "popup", actorId: "m" }), (e) => e instanceof Response && e.status === 400, "placement whitelist");
  await assert.rejects(saveContentBlock(db, { title: "Valid title", bodyMd: "Valid body copy", placement: "faq", validFrom: NOW, validUntil: NOW - 1, actorId: "m" }), (e) => e instanceof Response && e.status === 400, "window must end after it starts");
  const block = await publishedBlock(db);
  const edited = await saveContentBlock(db, { id: block.blockId, title: "Monsoon grooming care", bodyMd: "Updated: free towel-dry add-on.", placement: "home_banner", actorId: "m" });
  assert.equal(edited.version, 2, "live copy changes are versioned");
  assert.equal((await publicContent(db, { placement: "home_banner" })).blocks[0].version, 2);
  await setContentBlockStatus(db, { blockId: block.blockId, status: "archived", actorId: "m" });
  await assert.rejects(saveContentBlock(db, { id: block.blockId, title: "Zombie edit", bodyMd: "Should be refused.", placement: "home_banner", actorId: "m" }), (e) => e instanceof Response && e.status === 409);
  await assert.rejects(setContentBlockStatus(db, { blockId: block.blockId, status: "published", actorId: "m" }), (e) => e instanceof Response && e.status === 409, "archived never comes back");
  const events = sqlite.prepare("SELECT event_type FROM content_control_events WHERE entity_id=? ORDER BY created_at").all(block.blockId).map(row => row.event_type);
  assert.deepEqual(events, ["created", "published", "republished", "archived"], "the audit trail records every change");
});

// ---- 3. Feature controls ----------------------------------------------------------------------------

test("real execution: feature flags evaluate server-side against their rollout scope", async () => {
  freshDb();
  const db = globalThis.__CC_DB__;
  await setFeatureControl(db, { key: "Show Referral Banner", description: "Referral banner on home", enabled: true, cityIds: ["blr"], actorId: "staff:uat" });
  assert.equal(await featureEnabled(db, "show_referral_banner", { cityId: "blr" }), true, "key is normalized and scope matches");
  assert.equal(await featureEnabled(db, "show_referral_banner", { cityId: "pune" }), false, "outside the city scope");
  assert.equal(await featureEnabled(db, "show_referral_banner", {}), false, "scoped flags need a context to match");
  assert.equal(await featureEnabled(db, "unknown_flag", { cityId: "blr" }), false, "unknown flags are off, never invented");
  // The public read carries only flags whose scope matches the caller
  const blr = await publicContent(db, { cityId: "blr" });
  assert.deepEqual(blr.features, { show_referral_banner: true });
  const pune = await publicContent(db, { cityId: "pune" });
  assert.deepEqual(pune.features, {});
  // Disabling wins immediately and is audited
  await setFeatureControl(db, { key: "show_referral_banner", description: "Referral banner on home", enabled: false, cityIds: ["blr"], actorId: "staff:uat" });
  assert.equal(await featureEnabled(db, "show_referral_banner", { cityId: "blr" }), false);
  const events = sqlite.prepare("SELECT event_type FROM content_control_events WHERE entity_type='feature_control' ORDER BY created_at").all().map(row => row.event_type);
  assert.deepEqual(events, ["enabled", "disabled"]);
});

// ---- 4. Route: public vs staff permission split ------------------------------------------------------

test("real execution: the public GET needs no identity; admin view and mutations are permission-gated", async () => {
  freshDb();
  const db = globalThis.__CC_DB__;
  await publishedBlock(db);
  // Public read with NO auth headers at all
  const publicRead = await route.GET(new Request("https://app.pawspace.test/api/content-controls?placement=home_banner"));
  const publicBody = await parseBody(publicRead);
  assert.equal(publicRead.status, 200);
  assert.equal(publicBody.data.blocks.length, 1);
  assert.equal(publicBody.data.blocks[0].bodyMd, "Keep coats dry and book indoor slots.");
  // Staff overview via preview actor includes drafts + truth flags
  await saveContentBlock(db, { title: "Draft only staff can see", bodyMd: "Internal work in progress.", placement: "faq", actorId: "m" });
  const admin = await call("GET", "view=admin");
  assert.equal(admin.status, 200, JSON.stringify(admin.body));
  assert.equal(admin.body.data.metrics.draft, 1);
  assert.equal(admin.body.data.truth.publicReadServesPublishedOnly, true);
  // A customer identity can neither see the admin view nor author content nor flip features
  seedCustomerIdentity("mallory@pawspace.test");
  const adminDenied = await callAs("GET", "view=admin", "mallory@pawspace.test");
  assert.equal(adminDenied.status, 403, JSON.stringify(adminDenied.body));
  const saveDenied = await callAs("POST", { action: "save_block", title: "Injected banner", bodyMd: "Should be refused.", placement: "home_banner" }, "mallory@pawspace.test");
  assert.equal(saveDenied.status, 403);
  const featureDenied = await callAs("POST", { action: "set_feature", key: "sneaky_flag", description: "Should be refused.", enabled: true }, "mallory@pawspace.test");
  assert.equal(featureDenied.status, 403);
  // Preview staff can do all three through the real route
  const saved = await call("POST", { action: "save_block", title: "Route-authored banner", bodyMd: "Published through the route.", placement: "home_banner" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const published = await call("POST", { action: "publish_block", blockId: saved.body.data.blockId });
  assert.equal(published.status, 200);
  const feature = await call("POST", { action: "set_feature", key: "route_flag", description: "Flipped through the route.", enabled: true });
  assert.equal(feature.status, 200);
});

// ---- 5. Contracts -----------------------------------------------------------------------------------

test("contract: gateway permission line, DB access rule, and the marketing surface exist", () => {
  const gateway = fs.readFileSync(new URL("../lib/api-gateway.ts", import.meta.url), "utf8");
  assert.match(gateway, /content-controls"\)\{if\(method==="GET"\)return url\.searchParams\.get\("view"\)==="admin"\?"marketing\.manage":null/);
  assert.match(gateway, /"set_feature"\?"settings\.manage":"marketing\.manage"/);
  const source = fs.readFileSync(new URL("../app/api/content-controls/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /globalThis/, "the route must get the DB via cloudflare:workers env, never globalThis");
  const page = fs.readFileSync(new URL("../app/team/marketing/content/page.tsx", import.meta.url), "utf8");
  assert.match(page, /\/api\/content-controls/);
  const lib = fs.readFileSync(new URL("../lib/content-controls.ts", import.meta.url), "utf8");
  assert.match(lib, /status='published'/, "the public read is pinned to published rows");
});
