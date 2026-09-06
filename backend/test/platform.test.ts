import assert from "node:assert/strict";
import { test } from "node:test";
import { decideAssignment } from "../src/assignment.js";
import { issueSession, verifySession } from "../src/auth.js";
import { analyseLegacyCollections } from "../src/migration.js";
import { enqueueNotification, processNotification } from "../src/notifications.js";
import { MemoryRepository } from "../src/repository.js";

test("signed session preserves role and city scope",()=>{process.env.API_SECRET="pawspace-test-secret-with-at-least-32-characters";const session=issueSession({id:"ops_1",role:"operations",cityId:"blr"},300);const actor=verifySession(session.accessToken);assert.deepEqual(actor,{id:"ops_1",role:"operations",cityId:"blr"});});

test("assignment prefers full-time provider and does not require acceptance",async()=>{const repository=new MemoryRepository();const decision=await decideAssignment(repository,{cityId:"blr",zoneId:"blr-east",serviceCode:"grooming"});assert.equal(decision.provider?.id,"pro_arjun");assert.equal(decision.mode,"automatic");assert.equal(decision.offerExpiresAt,undefined);});

test("notification outbox records partial delivery from verified provider evidence",async()=>{const repository=new MemoryRepository();const event=await enqueueNotification(repository,{eventType:"booking.confirmed",customerId:"cus_10428",bookingId:"book_1",channels:["push","whatsapp"],templateCode:"booking_confirmation",payload:{}});assert.equal(event.status,"pending");const processed=await processNotification(repository,event.id,["push"],{verifiedDelivery:true});assert.equal(processed?.status,"partially_sent");assert.equal(processed?.attempts,1);});

test("migration analyser hashes and flags duplicate phones without exposing them",()=>{const report=analyseLegacyCollections([{name:"customers",documentCount:2,fields:["_id","phone"],indexes:["_id_"],sampleDocuments:[{_id:"a",phone:"9876543210"},{_id:"b",phone:"+91 98765 43210"}]}]);assert.equal(report.status,"blocked");assert.ok(report.findings.some(x=>x.code==="DUPLICATE_CUSTOMER_PHONE"));assert.ok(!JSON.stringify(report).includes("9876543210"));});
