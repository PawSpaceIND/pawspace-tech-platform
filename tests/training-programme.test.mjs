import assert from"node:assert/strict";
import test from"node:test";
import{readFile}from"node:fs/promises";
const source=async path=>readFile(new URL("../"+path,import.meta.url),"utf8");

test("Training materializes one programme and one canonical row per reserved session",async()=>{
 const engine=await source("lib/training-programme.ts");
 for(const table of["training_programmes","training_sessions","training_programme_events","canonical_bookings","scheduling_reservations"])assert.match(engine,new RegExp(table));
 assert.match(engine,/booking_id TEXT NOT NULL UNIQUE/);
 assert.match(engine,/schedule_reservation_id TEXT NOT NULL UNIQUE/);
 assert.match(engine,/UNIQUE\(programme_id,sequence_no\)/);
 assert.match(engine,/service_code='dog_training'/);
 assert.match(engine,/Training session provider does not match the canonical booking/);
 assert.match(engine,/Training session occurrence numbers must be unique/);
 assert.match(engine,/programme_materialized/);
 assert.match(engine,/trainer-meet-greet/);
 assert.match(engine,/Meet & Greet does not belong to this Training customer\/programme/);
});

test("Training programme API is customer-owned and session-safe",async()=>{
 const[api,gateway,sessionGateway]=await Promise.all([source("app/api/training-programmes/route.ts"),source("lib/api-gateway.ts"),source("lib/session-api-gateway.ts")]);
 assert.match(api,/requireCustomerOwnership\(db,actor,String\(booking.customer_id\)\)/);
 assert.match(api,/requirePermission\(actor,"scheduling.book"\)/);
 assert.match(api,/materializeTrainingProgramme/);
 assert.match(api,/training\.programme\.materialize/);
 assert.match(gateway,/\/api\/training-programmes/);
 assert.match(sessionGateway,/\/api\/training-programmes/);
 assert.match(sessionGateway,/await requiredPermission\(request\)/);
 assert.match(sessionGateway,/url\.pathname==="\/api\/training-programmes"&&\["GET","POST"\]\.includes\(method\)\)return\{subjectType:"customer"\}/);
 assert.doesNotMatch(sessionGateway,/permission:"scheduling\.book"/);
});

test("Training customer confirmation materializes the programme before showing success",async()=>{
 const[flow,client]=await Promise.all([source("app/mobile-app/training-flow.tsx"),source("lib/training-programme-client.ts")]);
 assert.match(flow,/materializeTrainingProgramme/);
 assert.match(flow,/bookingId:canonical\.bookingId/);
 assert.match(flow,/meetBookingId:linkedMeetBookingId\|\|undefined/);
 assert.ok(flow.indexOf("materializeTrainingProgramme")<flow.indexOf("setConfirmed(true)"));
 assert.match(client,/\/api\/training-programmes/);
});
