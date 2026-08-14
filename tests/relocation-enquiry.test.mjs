import test from"node:test";
import assert from"node:assert/strict";
import{readFile}from"node:fs/promises";
const read=path=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("relocation-enquiry lib defines its own table, memoized ensure, and strict field validation",async()=>{
  const lib=await read("lib/relocation-enquiry.ts");
  assert.match(lib,/CREATE TABLE IF NOT EXISTS relocation_enquiries/);
  assert.match(lib,/relocationEnquiryTablesEnsured=new WeakSet<Db>\(\)/);
  assert.match(lib,/if\(relocationEnquiryTablesEnsured\.has\(db\)\)return;/);
  assert.match(lib,/export async function ensureRelocationEnquiryTables/);
  assert.match(lib,/export async function createRelocationEnquiry/);
  assert.match(lib,/export async function listRelocationEnquiries/);
});

test("relocation-enquiry lib rejects anything other than dog/cat and enforces the exact field contract",async()=>{
  const lib=await read("lib/relocation-enquiry.ts");
  assert.match(lib,/PET_TYPES=\["dog","cat"\]/);
  assert.match(lib,/Pet type must be "dog" or "cat"/);
  assert.match(lib,/PHONE_RE=\/\^\\d\{10\}\$\//);
  assert.match(lib,/must be exactly 10 digits/);
  assert.match(lib,/EMAIL_RE=/);
  assert.match(lib,/A valid email address is required/);
  assert.match(lib,/DATE_RE=\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//);
  assert.match(lib,/Pickup date must be in YYYY-MM-DD format/);
  assert.match(lib,/Expected travel date must be in YYYY-MM-DD format/);
  assert.match(lib,/TIME_RE=/);
  assert.match(lib,/Pickup location is required/);
  assert.match(lib,/Drop location is required/);
  // Full required field contract present on the input type.
  for(const field of["customerName","phonePrimary","phoneSecondary","email","petType","pickupDate","pickupApproxTime","pickupLocation","dropLocation","expectedTravelDate"])
    assert.equal(lib.includes(field),true,field);
});

test("relocation-enquiry route: GET is staff-gated, POST create is public (no authorize call)",async()=>{
  const route=await read("app/api/relocation-enquiry/route.ts");
  assert.match(route,/export async function GET/);
  assert.match(route,/authorize\(request,"customers\.view"\)/);
  assert.match(route,/export async function POST/);
  assert.match(route,/sameOrigin\(request\)/);
  // GET is defined before POST in this file, so slicing from POST's start captures its full body
  // (through EOF) without picking up GET's authorize() call.
  const postSection=route.slice(route.indexOf("export async function POST"));
  assert.equal(postSection.includes("authorize("),false,"POST create must not call authorize() — it is public");
  assert.match(route,/createRelocationEnquiry\(db,input\)/);
  assert.match(route,/listRelocationEnquiries\(db\)/);
});

test("gateway allowlists relocation-enquiry create as public and gates list to customers.view",async()=>{
  const gateway=await read("lib/api-gateway.ts");
  assert.match(gateway,/if\(url\.pathname==="\/api\/relocation-enquiry"\)return method==="POST"\?null:"customers\.view";/);
});

test("customer relocation-enquiry page collects the exact field contract with a dog/cat-only pet type",async()=>{
  const page=await read("app/relocation-enquiry/page.tsx");
  assert.match(page,/"use client"/);
  assert.match(page,/\/api\/relocation-enquiry/);
  // relocationKind added to the contract (Finding 5): the page must send domestic/international, so it
  // is now part of the required field set and the page carries a domestic/international <select>.
  for(const token of["customerName","phonePrimary","phoneSecondary","email","petType","relocationKind","pickupDate","pickupApproxTime","pickupLocation","dropLocation","expectedTravelDate"])
    assert.equal(page.includes(token),true,token);
  assert.match(page,/<option value="dog">Dog<\/option>/);
  assert.match(page,/<option value="cat">Cat<\/option>/);
  assert.match(page,/<option value="domestic">Domestic within India<\/option>/);
  assert.match(page,/<option value="international">International<\/option>/);
  // Pet-type options remain dog/cat only; relocation-type options remain domestic/international only.
  assert.equal(/<option value="(?!dog|cat"|domestic"|international")/.test(page),false,"only dog/cat + domestic/international options allowed");
});

test("staff relocation-enquiries page lists submitted enquiries via GET",async()=>{
  const page=await read("app/team/relocation-enquiries/page.tsx");
  assert.match(page,/fetch\("\/api\/relocation-enquiry"/);
  for(const token of["customerName","phonePrimary","email","petType","pickupDate","pickupLocation","dropLocation","expectedTravelDate"])
    assert.equal(page.includes(token),true,token);
});

test("relocation-enquiry does not touch the existing relocation-case feature",async()=>{
  const existingPage=await read("app/relocation/page.tsx");
  const existingTeamPage=await read("app/team/relocation/page.tsx");
  // Sanity: the pre-existing relocation-case tokens (asserted by tests/relocation-closure.test.mjs)
  // are still present verbatim, i.e. nothing in this feature branch altered those files.
  assert.match(existingPage,/Create relocation inquiry/);
  assert.match(existingTeamPage,/Qualify lead/);
});

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import * as nodeModule from "node:module";
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `export async function resolve(specifier, context, nextResolve) {
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}
function wrapD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...boundArgs) => statement(sql, boundArgs),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return { prepare: (sql) => statement(sql, []), batch: async (statements) => { const results = []; for (const stmt of statements) results.push(await stmt.run()); return results; } };
}
const makeDb = () => wrapD1(new DatabaseSync(":memory:"));

// --- Domestic / International capture (founder requirement) --------------------------------------

test("relocation enquiry captures domestic vs international, validated and persisted", async () => {
  const { createRelocationEnquiry, listRelocationEnquiries } = await import("../lib/relocation-enquiry.ts");
  const db = makeDb();
  const base = {
    customerName: "Kind Verifier", phonePrimary: "9876543210", email: "kind@test.in", petType: "cat",
    pickupDate: "2026-09-01", pickupApproxTime: "10:00", pickupLocation: "Bengaluru", dropLocation: "Singapore", expectedTravelDate: "2026-09-05",
  };
  const intl = await createRelocationEnquiry(db, { ...base, relocationKind: "international" });
  assert.equal(intl.relocationKind, "international");
  const dom = await createRelocationEnquiry(db, { ...base, phonePrimary: "9876543211", dropLocation: "Mumbai", relocationKind: "domestic" });
  assert.equal(dom.relocationKind, "domestic");
  await assert.rejects(() => createRelocationEnquiry(db, { ...base, relocationKind: "interplanetary" }), /domestic.*international|Relocation type/);
  await assert.rejects(() => createRelocationEnquiry(db, { ...base, relocationKind: "" }), /Relocation type/);
  const listed = await listRelocationEnquiries(db);
  assert.deepEqual(listed.map(e => e.relocationKind).sort(), ["domestic", "international"]);
});

test("legacy relocation_enquiries table (without the kind column) migrates and reads back 'domestic'", async () => {
  const { ensureRelocationEnquiryTables, listRelocationEnquiries } = await import("../lib/relocation-enquiry.ts");
  const sqlite = new DatabaseSync(":memory:");
  // Older DDL copy exactly as shipped before this change.
  sqlite.exec("CREATE TABLE relocation_enquiries (id TEXT PRIMARY KEY,customer_name TEXT NOT NULL,phone_primary TEXT NOT NULL,phone_secondary TEXT,email TEXT NOT NULL,pet_type TEXT NOT NULL,pickup_date TEXT NOT NULL,pickup_approx_time TEXT NOT NULL,pickup_location TEXT NOT NULL,drop_location TEXT NOT NULL,expected_travel_date TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'new',created_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO relocation_enquiries VALUES ('RELQ-LEGACY','Old Row','9000000000',NULL,'old@test.in','dog','2026-08-01','09:00','Bengaluru','Chennai','2026-08-03','new',1)").run();
  const db = wrapD1(sqlite);
  await ensureRelocationEnquiryTables(db);
  const rows = await listRelocationEnquiries(db);
  assert.equal(rows[0].relocationKind, "domestic", "pre-migration rows default to domestic");
});

test("the embedded relocation flow posts every founder field including relocationKind and never fetches other endpoints", () => {
  const flow = readFileSync(new URL("../app/mobile-app/relocation-flow.tsx", import.meta.url), "utf8");
  for (const field of ["customerName", "phonePrimary", "phoneSecondary", "email", "petType", "relocationKind", "pickupDate", "pickupApproxTime", "pickupLocation", "dropLocation", "expectedTravelDate"]) {
    assert.ok(flow.includes(field), `flow must send ${field}`);
  }
  assert.match(flow, /"domestic" \| "international"|\["domestic", "international"\]/);
  const fetches = [...flow.matchAll(/fetch\("([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual([...new Set(fetches)], ["/api/relocation-enquiry"], "flow talks only to the enquiry endpoint");
  const shell = readFileSync(new URL("../app/mobile-app/page.tsx", import.meta.url), "utf8");
  assert.match(shell, /service\.name==="Relocation"\)return flow\(<RelocationFlow customer=\{customer\}\/>\)/);
});
