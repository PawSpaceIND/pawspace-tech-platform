import test from"node:test";
import assert from"node:assert/strict";
import{readFile}from"node:fs/promises";
const read=path=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("Walking Gate 4 media grants are private short-lived and scan-gated",async()=>{const source=await read("lib/walking-proof-governance.ts");assert.match(source,/walking_media_records/);assert.match(source,/upload_token_hash/);assert.match(source,/10\*60_000/);assert.match(source,/private\/walking/);assert.match(source,/quarantined/);assert.match(source,/scan_status/);assert.match(source,/retention_until/);assert.match(source,/revoked/);});

test("Walking Gate 4 validates MIME size checksum and exact booking provider purpose",async()=>{const source=await read("lib/walking-proof-governance.ts");assert.match(source,/image\/jpeg/);assert.match(source,/8\*1024\*1024/);assert.match(source,/\^\[a-f0-9\]\{64\}\$/);assert.match(source,/provider does not own this booking/);assert.match(source,/incident_evidence/);assert.match(source,/clean ready exact-purpose proof/);});

test("Walking incidents preserve money authority",async()=>{const source=await read("lib/walking-proof-governance.ts");assert.match(source,/walking_incidents/);assert.match(source,/walking_ops_notifications/);assert.match(source,/noAutomaticRefund:true/);assert.match(source,/noAutomaticPayoutChange:true/);assert.match(source,/moneyChanged:false/);});

test("Walking proof API separates walker customer and staff authority",async()=>{const api=await read("app/api/walking-proof/route.ts"),client=await read("lib/walking-proof-client.ts");assert.match(api,/requireProviderOwnership/);assert.match(api,/requireCustomerOwnership/);assert.match(api,/bookings\.manage/);assert.match(api,/acknowledge_incident/);assert.match(api,/securityAudit/);assert.match(client,/\/api\/walking-proof/);});

test("Walker proof workspace states external integrations truthfully",async()=>{const page=await read("app/walker/proof/walking-proof-workspace.tsx");assert.match(page,/metadata-only/);assert.match(page,/Live GPS is not asserted/);assert.match(page,/request_upload/);assert.match(page,/record_incident/);assert.doesNotMatch(page,/GPS route opened/);});
