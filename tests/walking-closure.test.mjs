import test from"node:test";
import assert from"node:assert/strict";
import{readFile}from"node:fs/promises";
const read=path=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("Dog Walking closes one canonical customer to walker to Ops to Finance path",async()=>{const customer=await read("app/walking/page.tsx"),booking=await read("app/api/walking-bookings/route.ts"),walker=await read("app/walker/page.tsx"),ops=await read("app/team/operations/walking/page.tsx"),finance=await read("app/team/finance/walking/walking-finance-workspace.tsx");assert.match(customer,/createCanonicalWalkingBooking/);assert.match(booking,/walking_sessions/);assert.match(walker,/loadWalkingLifecycle/);assert.match(ops,/loadWalkingOps/);assert.match(finance,/loadWalkingFinance/);});

test("Dog Walking completion is server-gated by canonical route evidence",async()=>{const lifecycle=await read("lib/walking-lifecycle.ts"),walker=await read("app/walker/page.tsx");assert.match(lifecycle,/Dog Walking UAT completion requires at least two canonical sandbox route samples/);assert.match(lifecycle,/event_type='route_location_sample'/);assert.match(lifecycle,/routeSamples/);assert.match(walker,/routeSamples<2/);assert.match(walker,/Record 2 route samples before completion/);assert.match(walker,/\/walker\/proof\?bookingId=/);});

test("Dog Walking customer confirmation reaches canonical management",async()=>{const page=await read("app/walking/page.tsx");assert.match(page,/\/walking\/manage\?bookingId=/);assert.match(page,/Manage walks/);});

test("Dog Walking recovery acceptance is explicit and preserves completed history",async()=>{const recovery=await read("lib/walking-recovery-governance.ts"),page=await read("app/walker/recovery/page.tsx"),ops=await read("lib/walking-ops-governance.ts");assert.match(recovery,/replacement_accepted/);assert.match(recovery,/completedSessionsPreserved:true/);assert.match(page,/Accept remaining walk schedule/);assert.match(ops,/Replacement walker must accept before Operations can close recovery/);});

test("Dog Walking gateway routes every gate to the correct authority",async()=>{const gateway=await read("lib/api-gateway.ts");for(const path of["walking-commercial","walking-bookings","walking-lifecycle","walking-finance","walking-proof","walking-ops","walking-recovery"])assert.match(gateway,new RegExp(`/api/${path}`));assert.match(gateway,/walking-finance[\s\S]*finance\.view/);assert.match(gateway,/walking-proof[\s\S]*acknowledge_incident[\s\S]*scheduling\.book/);assert.match(gateway,/walking-ops[\s\S]*bookings\.manage/);});

test("Dog Walking closure remains UAT-only and does not claim production launch",async()=>{const doc=await read("docs/WALKING_CLOSURE_PLAN.md"),ops=await read("lib/walking-ops-governance.ts"),proof=await read("lib/walking-proof-governance.ts");assert.match(doc,/not a production-launch declaration/i);assert.match(ops,/productionReady:false/);assert.match(ops,/productionGps:\"disconnected\"/);assert.match(proof,/productionGpsConnected:false/);assert.match(proof,/sandbox_unverified/);});
