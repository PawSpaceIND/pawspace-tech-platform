// Every identity the /staging-login page advertises must actually be able to sign in.
//
// The staging-login page and docs/UAT-TESTER-GUIDE.md offer five "jump in as" staff identities, but UAT
// sign-in (lib/uat-staging-auth.ts) refuses any email that is not an ACTIVE app_users row whose role has
// a definition. founder@pawspace.in was advertised as the headline "Founder (full access)" identity yet
// no seed created it as an app_users row, so the Founder journey could never be signed into — while the
// page still claimed "any email gets full access for testing", the opposite of what the hardened code
// does. These tests pin both: the advertised list is backed by the seed, and the false claim is gone.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

installWorkersHooks("__UAT_DB__", "__UAT_ENV__");
const uat = await import("../lib/uat-staging-auth.ts");
const { defaultRoles } = await import("../lib/platform-security.ts");
const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

const page = read("app/staging-login/page.tsx");
const seed = read("scripts/employee-seed.sql");
// The emails the login page offers as quick-jump identities.
const advertised = [...page.matchAll(/email:"([^"]+@[^"]+)"/g)].map((m) => m[1]);

test("the login page advertises the five seeded staff identities", () => {
  assert.ok(advertised.length >= 5, `expected at least 5 advertised identities, got ${advertised.length}`);
  assert.ok(advertised.includes("founder@pawspace.in"), "the Founder identity is advertised");
});

test("every advertised staging-login identity is an ACTIVE app_users row in employee-seed.sql", () => {
  for (const email of advertised) {
    const esc = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // …VALUES ('id','<email>','name','<role>','active',…) — same statement, so no ';' in between.
    const re = new RegExp(`INSERT OR IGNORE INTO app_users[^;]*'${esc}'[^;]*'active'`);
    assert.match(seed, re, `${email} must be seeded as an ACTIVE app_users row, or it cannot sign in`);
  }
});

test("the login page no longer claims an unrecognised email gets full access", () => {
  assert.doesNotMatch(page, /gets full access for testing/i, "the false 'any email = full access' claim must be gone");
  assert.doesNotMatch(page, /Any other email works too/i, "and its stale source comment");
});

// batch() is one transaction in D1: see tests/helpers/d1.mjs.
const makeD1 = (sqlite) => createD1(sqlite);

test("behaviour: the seeded founder resolves to the founder role; an unknown email is still refused", async () => {
  const s = new DatabaseSync(":memory:");
  s.exec(seed); // load the real staff directory the deploy actually ships
  // role_definitions are seeded at runtime by ensureSecurityTables from the platform defaults.
  s.exec("CREATE TABLE IF NOT EXISTS role_definitions (code TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, permissions_json TEXT NOT NULL, system_role INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)");
  for (const r of defaultRoles) s.prepare("INSERT OR IGNORE INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (?,?,?,?,1,0)").run(r.code, r.name, r.description, JSON.stringify(r.permissions));
  const db = makeD1(s);

  assert.equal(await uat.uatStaffIdentityAllowed(db, "founder@pawspace.in"), true, "the advertised Founder identity must be allowed to sign in");
  assert.equal(await uat.uatStaffIdentityAllowed(db, "unknown.person@example.com"), false, "an unrecognised email is still refused (hardening intact)");

  const env = { PAWSPACE_UAT_LOGIN: "on", PAWSPACE_UAT_SIGNING_KEY: "a-test-signing-key-that-is-long-enough-32" };
  const token = await uat.issueUatToken(env, "founder@pawspace.in", 3600);
  const request = new Request("http://localhost/x", { headers: { cookie: `pawspace_uat=${encodeURIComponent(token)}` } });
  const actor = await uat.resolveUatStaffActor(db, request, env);
  assert.ok(actor, "the founder cookie must resolve to an actor");
  assert.equal(actor.roleCode, "founder", "and to the founder role from the directory");
  assert.ok(actor.permissions.includes("*"), "founder holds the wildcard permission");
  assert.equal(actor.developmentPreview, false, "nothing is synthesised — it is a real seeded row");
});
