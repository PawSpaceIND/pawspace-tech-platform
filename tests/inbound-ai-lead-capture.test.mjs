import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({ resolve(specifier, context, nextResolve) { if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true }; try { return nextResolve(specifier, context); } catch (error) { if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context); throw error; } } });
} else {
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(`export async function resolve(specifier,context,nextResolve){if(specifier==='cloudflare:workers')return{url:${JSON.stringify(workersUrl)},shortCircuit:true};try{return await nextResolve(specifier,context)}catch(error){if(specifier.startsWith('.')&&!specifier.endsWith('.ts'))return nextResolve(specifier+'.ts',context);throw error}}`)}`));
}
function makeD1(sqlite) {
  function statement(sql, args) { return { bind: (...bound) => statement(sql, bound), first: async () => sqlite.prepare(sql).get(...args) ?? null, run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes), rows_written: Number(info.changes) } }; }, all: async () => ({ results: sqlite.prepare(sql).all(...args) }) }; }
  return { prepare: sql => statement(sql, []), batch: async list => { const out=[]; for(const item of list) out.push(await item.run()); return out; }, exec: async sql => sqlite.exec(sql) };
}

test("unknown inbound caller becomes one canonical customer and one CRM lead, while ambiguous identity still fails closed", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  const { resolveOrCaptureInboundCaller } = await import("../lib/inbound-ai-lead-capture.ts");
  const now = Date.now();
  const first = await resolveOrCaptureInboundCaller(db, "+91 98765 43210", now);
  assert.equal(first.capturedLead, true);
  assert.ok(first.customerId);
  assert.ok(first.leadId);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM canonical_customers WHERE id=?").get(first.customerId).c, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM crm_contacts WHERE id=?").get(first.customerId).c, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM lead_work_items WHERE id=?").get(first.leadId).c, 1);
  const replay = await resolveOrCaptureInboundCaller(db, "9876543210", now + 1);
  assert.equal(replay.capturedLead, false);
  assert.equal(replay.customerId, first.customerId);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM canonical_customers").get().c, 1);
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES ('DUP-CUS','blr','Duplicate','9876543210','test','{}',?,?)").run(now,now);
  await assert.rejects(() => resolveOrCaptureInboundCaller(db, "9876543210", now + 2), error => error instanceof Response && error.status === 409);
});
