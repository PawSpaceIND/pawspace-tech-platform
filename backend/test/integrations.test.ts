import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { buildApp } from "../src/app.js";
import type { NotificationEvent } from "../src/domain.js";
import { buildIntegrationGateway, processNotificationOutbox, verifyHmac } from "../src/integrations.js";
import { enqueueNotification } from "../src/notifications.js";
import { MemoryRepository } from "../src/repository.js";

const ops={"x-user-id":"ops_karthik","x-role":"operations","x-city-id":"blr"};

test("integration registry exposes explicit provider states",async()=>{const app=buildApp(new MemoryRepository());const response=await app.inject({method:"GET",url:"/v1/integrations/health",headers:ops});assert.equal(response.statusCode,200);assert.equal(response.json().data.length,12);assert.equal(response.json().meta.productionReady,false);const byKey=Object.fromEntries(response.json().data.map((x:{key:string;status:string})=>[x.key,x.status]));assert.equal(byKey.maps,"configuration_required");assert.equal(byKey.media,"configuration_required");assert.equal(byKey.ai,"configuration_required");assert.equal(byKey.voice,"disabled");await app.close();});

test("HMAC webhook verification rejects tampering",()=>{const payload=JSON.stringify({event:"payment.captured",id:"pay_123"});const secret="test-secret";const signature=createHmac("sha256",secret).update(payload).digest("hex");assert.equal(verifyHmac(payload,signature,secret),true);assert.equal(verifyHmac(`${payload}x`,signature,secret),false);});

test("Razorpay webhook accepts only a verified payload",async()=>{process.env.RAZORPAY_WEBHOOK_SECRET="test-webhook-secret";const app=buildApp(new MemoryRepository());const payload=JSON.stringify({event:"payment.captured",id:"pay_123"});const signature=createHmac("sha256",process.env.RAZORPAY_WEBHOOK_SECRET).update(payload).digest("hex");const accepted=await app.inject({method:"POST",url:"/v1/webhooks/razorpay",payload:{payload,signature}});assert.equal(accepted.statusCode,202);const denied=await app.inject({method:"POST",url:"/v1/webhooks/razorpay",payload:{payload,signature:`${signature.slice(0,-1)}0`}});assert.equal(denied.statusCode,401);await app.close();delete process.env.RAZORPAY_WEBHOOK_SECRET;});

test("outbox runner preserves successful channels and retries failures",async()=>{const repository=new MemoryRepository();const event=await enqueueNotification(repository,{eventType:"booking.confirmed",customerId:"cus_10428",channels:["push","whatsapp"],templateCode:"booking_confirmation",payload:{}});const gateway=buildIntegrationGateway({failChannels:new Set(["whatsapp"]),allowSandboxSuccess:true});const result=await processNotificationOutbox(repository,gateway);assert.equal(result.evaluated,1);const saved=(await repository.listNotifications()).find(x=>x.id===event.id);assert.equal(saved?.status,"partially_sent");assert.deepEqual(saved?.payload.deliveredChannels,["push"]);assert.equal(saved?.attempts,1);});

test("unconfigured communications fail closed instead of reporting delivery",async()=>{const repository=new MemoryRepository();const event=await enqueueNotification(repository,{eventType:"booking.confirmed",customerId:"cus_10428",channels:["whatsapp","sms","email"],templateCode:"booking_confirmation",payload:{}});const result=await processNotificationOutbox(repository,buildIntegrationGateway());assert.equal(result.evaluated,1);const row=result.results[0];assert.ok(row&&"failures" in row);assert.deepEqual(row.deliveredChannels,[]);const failures=row&&"failures" in row?(row.failures??[]):[];assert.deepEqual(failures.map(x=>x.errorCode),["PROVIDER_NOT_CONFIGURED","PROVIDER_NOT_CONFIGURED","PROVIDER_NOT_CONFIGURED"]);const saved=(await repository.listNotifications()).find(x=>x.id===event.id);assert.equal(saved?.status,"failed");assert.equal(saved?.attempts,1);});

test("maps without credentials never reports tracking ready",async()=>{delete process.env.MAPS_API_KEY;const result=await buildIntegrationGateway().quoteRoute("HSR Layout","Indiranagar");assert.equal(result.trackingReady,false);assert.equal(result.errorCode,"MAPS_NOT_CONFIGURED");});

test("voice delivery is disabled by default",async()=>{delete process.env.VOICE_TELEPHONY_ENABLED;delete process.env.VOICE_PROVIDER_API_KEY;const timestamp=new Date().toISOString();const event:NotificationEvent={id:"notify_voice",eventType:"test",channels:["voice"],templateCode:"test",payload:{},status:"pending",attempts:0,nextAttemptAt:timestamp,createdAt:timestamp,updatedAt:timestamp};const result=await buildIntegrationGateway().deliver("voice",event);assert.equal(result.delivered,false);assert.equal(result.errorCode,"VOICE_DISABLED");});
