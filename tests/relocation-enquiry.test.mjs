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
  for(const token of["customerName","phonePrimary","phoneSecondary","email","petType","pickupDate","pickupApproxTime","pickupLocation","dropLocation","expectedTravelDate"])
    assert.equal(page.includes(token),true,token);
  assert.match(page,/<option value="dog">Dog<\/option>/);
  assert.match(page,/<option value="cat">Cat<\/option>/);
  assert.equal(/<option value="(?!dog|cat")/.test(page),false,"only dog/cat options allowed");
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
