import test from"node:test";
import assert from"node:assert/strict";
import{readFile}from"node:fs/promises";
const read=path=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("service-zones lib maps real Bengaluru pincodes to their real zones",async()=>{
  // This test previously pinned the FABRICATED table: it asserted 560034 (Koramangala) was in the
  // east zone and 560010 (Rajajinagar) in the north. Both are wrong on the ground, so the test was
  // holding the defect in place rather than catching it - a green assertion over invented data.
  // It now checks the geography that actually exists. tests/service-zone-coverage.test.mjs executes
  // the resolver against every advertised pincode; this one guards the table's shape and anchors.
  const lib=await read("lib/service-zones.ts");
  assert.match(lib,/PINCODE_ZONE_MAP:Record<string,ZoneAssignment>=/);
  assert.match(lib,/"560034":{pincode:"560034",zoneId:"blr-south"/);   // Koramangala
  assert.match(lib,/"560102":{pincode:"560102",zoneId:"blr-south"/);   // HSR Layout
  assert.match(lib,/"560038":{pincode:"560038",zoneId:"blr-east"/);    // Indiranagar
  assert.match(lib,/"560066":{pincode:"560066",zoneId:"blr-east"/);    // Whitefield
  assert.match(lib,/"560010":{pincode:"560010",zoneId:"blr-west"/);    // Rajajinagar
  assert.match(lib,/"560032":{pincode:"560032",zoneId:"blr-north"/);   // Hebbal / RT Nagar
  assert.match(lib,/"560001":{pincode:"560001",zoneId:"blr-central"/); // MG Road
});

test("service-zones lib defines SERVICE_ZONES with color and availability flags",async()=>{
  const lib=await read("lib/service-zones.ts");
  assert.match(lib,/export const SERVICE_ZONES:Record<string,ServiceZone>=/);
  assert.match(lib,/"blr-east":{zoneId:"blr-east",zoneName:"East Bengaluru"/);
  assert.match(lib,/"blr-north":{zoneId:"blr-north",zoneName:"North Bengaluru"/);
  assert.match(lib,/"blr-west":{zoneId:"blr-west",zoneName:"West Bengaluru"/);
  assert.match(lib,/"blr-south":{zoneId:"blr-south",zoneName:"South Bengaluru"/);
  assert.match(lib,/"blr-central":{zoneId:"blr-central",zoneName:"Central Bengaluru"/);
  assert.match(lib,/color:"#[0-9A-F]{6}"/);
  assert.match(lib,/serviceAvailable:true/);
});

test("service-zones lib exports resolveZoneByPincode, listServiceZones, seedDefaultZones",async()=>{
  const lib=await read("lib/service-zones.ts");
  assert.match(lib,/export async function resolveZoneByPincode\(db:Db,pincode:string\)/);
  assert.match(lib,/export async function listServiceZones\(db:Db\)/);
  assert.match(lib,/export async function seedDefaultZones\(db:Db\)/);
  assert.match(lib,/PINCODE_ZONE_MAP\[normalized\]/);
});

test("service-zones lib creates service_zone_mappings table with indexes",async()=>{
  const lib=await read("lib/service-zones.ts");
  assert.match(lib,/CREATE TABLE IF NOT EXISTS service_zone_mappings/);
  assert.match(lib,/pincode TEXT PRIMARY KEY/);
  assert.match(lib,/zone_id TEXT NOT NULL/);
  assert.match(lib,/CREATE INDEX IF NOT EXISTS service_zone_area_idx/);
});

test("service-zone route is public (no authorize call)",async()=>{
  const route=await read("app/api/service-zone/route.ts");
  assert.match(route,/export async function GET\(request:Request\)/);
  assert.match(route,/const pincode=url.searchParams.get\("pincode"\)/);
  assert.match(route,/const action=url.searchParams.get\("action"\)\\|\\|"resolve"/);
  // Verify no authorize() call anywhere in the file
  assert.equal(route.includes("authorize("),false,"GET /api/service-zone must not call authorize() — it is public");
  assert.match(route,/resolveZoneByPincode\(db,pincode\)/);
  assert.match(route,/listServiceZones\(db\)/);
});

test("service-zone route handles resolve, list, and seed actions",async()=>{
  const route=await read("app/api/service-zone/route.ts");
  assert.match(route,/if\(action==="resolve"\)/);
  assert.match(route,/if\(action==="list"\)/);
  assert.match(route,/if\(action==="seed"\)/);
});

test("gateway allowlists service-zone as public",async()=>{
  const gateway=await read("lib/api-gateway.ts");
  assert.match(gateway,/\|\|url\.pathname===\"\/api\/service-zone\"\)/);
});

test("address-picker component collects pincode and resolves zone",async()=>{
  const page=await read("app/mobile-app/address-picker.tsx");
  assert.match(page,/"use client"/);
  assert.match(page,/\/api\/service-zone/);
  assert.match(page,/replace\(\/\\D\/g,""\)\.slice\(0,6\)/);
  assert.match(page,/onZoneResolved/);
  assert.match(page,/setPincode/);
  assert.match(page,/const\[pincode,setPincode\]/);
});
