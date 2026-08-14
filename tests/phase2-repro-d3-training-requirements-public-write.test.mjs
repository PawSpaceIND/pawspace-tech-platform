import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// =============================================================================
// PHASE 2 REPRODUCTION — D3 (P2): /api/training-requirements POST & PATCH are fully public,
// unauthenticated writes. The path is in the gateway PUBLIC null-list and the handler performs NO
// resolveActor/authorize and NO same-origin check, so any anonymous caller can INSERT arbitrary
// requirement rows (content defacement / row-flood) or relabel/deactivate any row by id.
// Run against the frozen target SHA 0d8b885.
// =============================================================================
installWorkersHooks("__D3_DB__", "__D3_ENV__");

function makeD1(sqlite) {
  const s = (sql, args) => ({
    bind: (...b) => s(sql, b),
    first: async () => { const r = sqlite.prepare(sql).get(...args); return r === undefined ? null : r; },
    run: async () => { const i = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(i.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return { prepare: (sql) => s(sql, []), batch: async (l) => { const o = []; for (const it of l) o.push(await it.run()); return o; }, exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; } };
}
function freshDb() { const sqlite = new DatabaseSync(":memory:"); globalThis.__D3_DB__ = makeD1(sqlite); globalThis.__D3_ENV__ = {}; return sqlite; }
// Fully anonymous request: no cookie, no oai-authenticated-user-email header, non-localhost host.
const anon = (method, body) => new Request("https://uat.pawspace.in/api/training-requirements", { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const bodyOf = async (res) => { try { return await res.clone().json(); } catch { return null; } };
async function driveGateway(request, db) {
  const { authorizePlatformSessionRequest } = await import("../lib/session-api-gateway.ts");
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  const sessionAccess = await authorizePlatformSessionRequest(request, db);
  if (sessionAccess instanceof Response) return sessionAccess;
  return sessionAccess ?? await authorizeApiRequest(request, { DB: db });
}
const route = await import("../app/api/training-requirements/route.ts");
const count = (sqlite) => { try { return sqlite.prepare("SELECT COUNT(*) c FROM training_requirements").get().c; } catch { return 0; } };

test("D3 REPRODUCED — the gateway PERMITS an anonymous POST (path is in the public null-list)", async () => {
  const sqlite = freshDb();
  const access = await driveGateway(anon("POST", { label: "gateway check" }), globalThis.__D3_DB__);
  assert.ok(!(access instanceof Response), "gateway lets an anonymous training-requirements POST through (public)");
  assert.equal(access.permission, null, "no permission is required — the route is public for all methods");
  // Suppress DB side-effects of the seed inside the gateway check by using a separate row-count later.
  void sqlite;
});

test("D3 REPRODUCED — anonymous POST INSERTS a persisted requirement row", async () => {
  const sqlite = freshDb();
  const before = count(sqlite);
  const res = await route.POST(anon("POST", { label: "Injected by an anonymous caller" }));
  assert.equal(res.status, 201, `anonymous POST currently succeeds: ${JSON.stringify(await bodyOf(res))}`);
  const after = count(sqlite);
  assert.ok(after > before, "a new row was persisted");
  const row = sqlite.prepare("SELECT label FROM training_requirements WHERE label=?").get("Injected by an anonymous caller");
  assert.ok(row, "the attacker-chosen label is now in the catalogue");
});

test("D3 REPRODUCED — anonymous PATCH mutates an existing requirement (relabel + deactivate)", async () => {
  const sqlite = freshDb();
  await route.GET(); // seeds the default requirements
  const target = sqlite.prepare("SELECT id,version,active FROM training_requirements ORDER BY sort_order LIMIT 1").get();
  const res = await route.PATCH(anon("PATCH", { id: target.id, label: "Defaced label", active: false }));
  assert.equal(res.status, 200, `anonymous PATCH currently succeeds: ${JSON.stringify(await bodyOf(res))}`);
  const after = sqlite.prepare("SELECT label,active,version FROM training_requirements WHERE id=?").get(target.id);
  assert.equal(after.label, "Defaced label", "an anonymous caller relabelled a catalogue row");
  assert.equal(after.active, 0, "an anonymous caller deactivated it");
  assert.equal(after.version, target.version + 1, "the write bumped the row version");
});

test("D3 SECURE INVARIANT (post-fix gate) — unauthenticated POST/PATCH must be REJECTED and write nothing", async () => {
  const sqlite = freshDb();
  const before = count(sqlite);
  const postRes = await route.POST(anon("POST", { label: "should be rejected" }));
  const patchSeed = freshDb(); await route.GET(); const anyRow = patchSeed.prepare("SELECT id FROM training_requirements LIMIT 1").get();
  const patchRes = await route.PATCH(anon("PATCH", { id: anyRow?.id || "training_requirement_1", label: "should be rejected" }));
  // Expected after remediation: catalogue writes require staff authorization (e.g. settings.manage).
  // FAILS on 0d8b885 — the writes currently succeed (201/200).
  assert.ok([401, 403].includes(postRes.status), `unauthenticated POST must be refused; got ${postRes.status}`);
  assert.ok([401, 403].includes(patchRes.status), `unauthenticated PATCH must be refused; got ${patchRes.status}`);
  assert.equal(count(sqlite), before, "a rejected POST must not persist a row");
});
