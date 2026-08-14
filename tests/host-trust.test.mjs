import test from"node:test";
import assert from"node:assert/strict";
import{readFile}from"node:fs/promises";
const read=path=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("host-reviews lib defines host_reviews table with UNIQUE booking_id constraint",async()=>{
  const lib=await read("lib/host-reviews.ts");
  assert.match(lib,/CREATE TABLE IF NOT EXISTS host_reviews/);
  assert.match(lib,/booking_id TEXT NOT NULL UNIQUE/);
  assert.match(lib,/rating INTEGER NOT NULL/);
  assert.match(lib,/title TEXT NOT NULL/);
  assert.match(lib,/body TEXT NOT NULL/);
  assert.match(lib,/created_at INTEGER NOT NULL/);
});

test("host-reviews lib defines host_review_replies table with foreign key",async()=>{
  const lib=await read("lib/host-reviews.ts");
  assert.match(lib,/CREATE TABLE IF NOT EXISTS host_review_replies/);
  assert.match(lib,/review_id TEXT NOT NULL/);
  assert.match(lib,/FOREIGN KEY\(review_id\) REFERENCES host_reviews\(id\)/);
});

test("host-reviews lib exports submitHostReview with booking validation",async()=>{
  const lib=await read("lib/host-reviews.ts");
  assert.match(lib,/export async function submitHostReview/);
  assert.match(lib,/const booking=await db.prepare\("SELECT.*FROM canonical_bookings WHERE id=\?"\)/);
  assert.match(lib,/String\(booking\.customer_id\)!==customerId/);
  assert.match(lib,/String\(booking\.provider_id\)!==hostProviderId/);
  assert.match(lib,/String\(booking\.status\)!=="completed"/);
  assert.match(lib,/const existing=await db.prepare\("SELECT id FROM host_reviews WHERE booking_id=\?"\)/);
  assert.match(lib,/Review already submitted for this booking/);
});

test("host-reviews lib validates rating 1-5",async()=>{
  const lib=await read("lib/host-reviews.ts");
  assert.match(lib,/rating<1\|\|rating>5/);
  assert.match(lib,/Rating must be an integer between 1 and 5/);
});

test("host-reviews lib exports listHostReviews with stats aggregation",async()=>{
  const lib=await read("lib/host-reviews.ts");
  assert.match(lib,/export async function listHostReviews/);
  assert.match(lib,/AVG\(rating\) avg_rating/);
  assert.match(lib,/ratingHistogram/);
  assert.match(lib,/const histogram:Record<1\|2\|3\|4\|5,number>/);
});

test("host-reviews lib includes seedHostReviews with uat_seed_ prefix",async()=>{
  const lib=await read("lib/host-reviews.ts");
  assert.match(lib,/export async function seedHostReviews/);
  assert.match(lib,/uat_seed_customer_/);
  assert.match(lib,/"boarding":"pet_sitting"/);
});

test("host-badges lib exports computeHostBadges function",async()=>{
  const lib=await read("lib/host-badges.ts");
  assert.match(lib,/export function computeHostBadges\(stats:HostStats\):Badge\[\]/);
});

test("host-badges lib implements Superhost badge rule",async()=>{
  const lib=await read("lib/host-badges.ts");
  assert.match(lib,/stats\.completedStays>=10&&stats\.avgRating>=4\.8/);
  assert.match(lib,/"superhost"/);
  assert.match(lib,/Superhost/);
});

test("host-badges lib implements Medication Pro and Verified Home badges",async()=>{
  const lib=await read("lib/host-badges.ts");
  assert.match(lib,/stats\.medicationSupport/);
  assert.match(lib,/"medication-pro"/);
  assert.match(lib,/stats\.homeVerified/);
  assert.match(lib,/"verified-home"/);
});

test("host-badges lib implements Zero Cancellations badge rule",async()=>{
  const lib=await read("lib/host-badges.ts");
  assert.match(lib,/stats\.completedStays>=5&&stats\.hostCancelledCount===0/);
  assert.match(lib,/"zero-cancellations"/);
});

test("host-badges lib implements Quick Responder badge rule",async()=>{
  const lib=await read("lib/host-badges.ts");
  assert.match(lib,/stats\.acceptanceTimeout<=180/);
  assert.match(lib,/"quick-responder"/);
});

test("host-badges lib exports computeHostStats with real queries",async()=>{
  const lib=await read("lib/host-badges.ts");
  assert.match(lib,/export async function computeHostStats/);
  assert.match(lib,/canonical_bookings/);
  assert.match(lib,/provider_capacity_profiles/);
  assert.match(lib,/host_reviews/);
});

test("host-trust GET is a public read, but POST now requires an authenticated staff session (D4 tightening)",async()=>{
  const route=await read("app/api/host-trust/route.ts");
  assert.match(route,/export async function GET/);
  assert.match(route,/export async function POST/);
  // GET stays a public catalog read (still driven by the hostProviderId query param, no session).
  assert.match(route,/hostProviderId=url\.searchParams\.get\("hostProviderId"\)/);
  // POST is no longer anonymous: it resolves a real staff actor and enforces providers.manage before any write.
  assert.match(route,/resolveActor\(request\)/);
  assert.match(route,/requirePermission/);
  assert.match(route,/"providers\.manage"/);
});

test("host-trust route calls submitHostReview for reviews",async()=>{
  const route=await read("app/api/host-trust/route.ts");
  assert.match(route,/submitHostReview/);
});

test("host-trust route includes seed action for test data, fail-closed behind the UAT switch",async()=>{
  const route=await read("app/api/host-trust/route.ts");
  assert.match(route,/body\.action==="seed"/);
  assert.match(route,/seedHostReviews/);
  // The synthetic seed fixture can only run on a staging/UAT build with the explicit switch on.
  assert.match(route,/PAWSPACE_UAT_LOGIN/);
});

test("gateway makes host-trust GET public but gates its writes on providers.manage (D4)",async()=>{
  const gateway=await read("lib/api-gateway.ts");
  assert.match(gateway,/url\.pathname===\"\/api\/host-trust\"\)return method===\"GET\"\?null:\"providers\.manage\"/);
});

test("host-trust-panel component does not import flows",async()=>{
  const panel=await read("app/mobile-app/host-trust-panel.tsx");
  assert.match(panel,/"use client"/);
  assert.match(panel,/\/api\/host-trust/);
  assert.equal(panel.includes("stay-flow"),false,"host-trust-panel must not import stay-flow");
  assert.equal(panel.includes("checkout"),false,"host-trust-panel must not import checkout flows");
  assert.equal(panel.includes("grooming-flow"),false,"host-trust-panel must not import grooming-flow");
});

test("host-trust-panel displays badges, stats, and reviews",async()=>{
  const panel=await read("app/mobile-app/host-trust-panel.tsx");
  assert.match(panel,/Badge/);
  assert.match(panel,/stats\.completedStays/);
  assert.match(panel,/aggregateStats\.ratingHistogram/);
  assert.match(panel,/Review\[/);
});

test("host-trust-panel uses Emerald and Gold theme colors",async()=>{
  const panel=await read("app/mobile-app/host-trust-panel.tsx");
  assert.match(panel,/var\(--ds-primary-500\)/);
  assert.match(panel,/var\(--ds-surface\)/);
  assert.match(panel,/var\(--ds-border\)/);
});

test("host-trust-panel includes pagination for reviews",async()=>{
  const panel=await read("app/mobile-app/host-trust-panel.tsx");
  assert.match(panel,/pagination/i);
  assert.match(panel,/Previous/);
  assert.match(panel,/Next/);
});

test("no API route resolves the database from globalThis - cloudflare:workers env only",async()=>{
  // Regression: two parallel-account routes (host-trust, service-zone) fetched the DB from
  // globalThis.__D1__, which exists nowhere in the runtime - every request 500'd once deployed.
  const{readdir,readFile}=await import("node:fs/promises");
  const{join}=await import("node:path");
  const root=new URL("../app/api",import.meta.url).pathname;
  const entries=await readdir(root,{withFileTypes:true});
  for(const entry of entries){
    if(!entry.isDirectory())continue;
    const routePath=join(root,entry.name,"route.ts");
    const source=await readFile(routePath,"utf8").catch(()=>"");
    if(!source)continue;
    if(source.includes("__D1__")||/globalThis[^\n]*\bDB\b/.test(source)){
      throw new Error(`${entry.name}/route.ts resolves the DB from globalThis - use: const {env}=await import("cloudflare:workers")`);
    }
  }
});

test("host stats read verification flags from boarding_host_profiles with real column names",async()=>{
  const{readFile}=await import("node:fs/promises");
  const lib=await readFile(new URL("../lib/host-badges.ts",import.meta.url),"utf8");
  // The original queries referenced acceptance_timeout_sec / medication_support / home_verified /
  // kyc_verified on provider_capacity_profiles - none of those columns exist there, and the
  // safeFirst .catch fallback silently returned every flag as false.
  assert.match(lib,/acceptance_timeout_minutes/);
  assert.doesNotMatch(lib,/acceptance_timeout_sec/);
  assert.match(lib,/SELECT medication_support,home_verified,kyc_status FROM boarding_host_profiles/);
});
