import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/app.js";
import { MemoryRepository } from "../src/repository.js";

const headers={"x-user-id":"ops_karthik","x-role":"operations","x-city-id":"blr"};

async function seededAssignedBooking(repository:MemoryRepository){
  const timestamp="2026-08-08T02:00:00.000Z";
  return repository.createBooking({id:"book_provider_guard",legacyIds:[],idempotencyKey:"provider-guard-001",cityId:"blr",zoneId:"blr-east",customerId:"cus_10428",petIds:["pet_bruno"],serviceCode:"grooming",packageCode:"bath_basic",addonCodes:[],scheduledStart:"2026-08-08T03:30:00.000Z",scheduledEnd:"2026-08-08T05:30:00.000Z",status:"assigned",channel:"operations_assisted",totalAmount:1899,providerId:"pro_arjun",assignmentMode:"automatic",createdBy:"ops_karthik",createdAt:timestamp,updatedAt:timestamp});
}

test("health endpoint",async()=>{const app=buildApp(new MemoryRepository());const response=await app.inject({method:"GET",url:"/health"});assert.equal(response.statusCode,200);assert.equal(response.json().status,"ok");await app.close();});

test("search masks customer number for operations",async()=>{const app=buildApp(new MemoryRepository());const response=await app.inject({method:"GET",url:"/v1/customers?q=Meera",headers});assert.equal(response.statusCode,200);assert.match(response.json().data[0].primaryPhone,/•/);await app.close();});

test("creates an idempotent assisted booking and auto assigns full-time provider",async()=>{const repository=new MemoryRepository();await repository.upsertAvailability({id:"a1",providerId:"pro_arjun",cityId:"blr",zoneId:"blr-east",date:"2026-08-08",windows:["09:00-19:00"],source:"roster",updatedAt:new Date().toISOString()});const app=buildApp(repository);const payload={customerId:"cus_10428",petIds:["pet_bruno"],serviceCode:"grooming",packageCode:"bath_basic",addonCodes:[],zoneId:"blr-east",scheduledStart:"2026-08-08T03:30:00.000Z",scheduledEnd:"2026-08-08T05:30:00.000Z",channel:"operations_assisted"};const first=await app.inject({method:"POST",url:"/v1/bookings",headers:{...headers,"idempotency-key":"booking-test-001"},payload});assert.equal(first.statusCode,201);assert.equal(first.json().data.totalAmount,1899);assert.equal(first.json().data.assignmentMode,"automatic");const second=await app.inject({method:"POST",url:"/v1/bookings",headers:{...headers,"idempotency-key":"booking-test-001"},payload});assert.equal(second.statusCode,200);assert.equal(second.json().meta.duplicatePrevented,true);await app.close();});

test("rejects assisted booking by customer role",async()=>{const app=buildApp(new MemoryRepository());const response=await app.inject({method:"POST",url:"/v1/bookings",headers:{"x-user-id":"cus_10428","x-role":"customer","x-city-id":"blr","idempotency-key":"booking-test-002"},payload:{customerId:"cus_10428",petIds:["pet_bruno"],serviceCode:"grooming",packageCode:"bath_basic",zoneId:"blr-east",scheduledStart:"2026-08-08T03:30:00.000Z",scheduledEnd:"2026-08-08T05:30:00.000Z",channel:"sales_assisted"}});assert.equal(response.statusCode,403);await app.close();});

test("provider cannot mutate another provider booking status",async()=>{const repository=new MemoryRepository();await seededAssignedBooking(repository);const app=buildApp(repository);const response=await app.inject({method:"PATCH",url:"/v1/bookings/book_provider_guard/status",headers:{"x-user-id":"pro_kiran","x-role":"provider","x-city-id":"blr"},payload:{status:"on_the_way"}});assert.equal(response.statusCode,403);assert.equal((await repository.getBooking("book_provider_guard"))?.status,"assigned");await app.close();});

test("provider booking lifecycle permits only governed forward transitions",async()=>{const repository=new MemoryRepository();await seededAssignedBooking(repository);const app=buildApp(repository);const own={"x-user-id":"pro_arjun","x-role":"provider","x-city-id":"blr"};const jump=await app.inject({method:"PATCH",url:"/v1/bookings/book_provider_guard/status",headers:own,payload:{status:"arrived"}});assert.equal(jump.statusCode,409);assert.equal((await repository.getBooking("book_provider_guard"))?.status,"assigned");for(const status of ["on_the_way","arrived","in_service","completed"]){const response=await app.inject({method:"PATCH",url:"/v1/bookings/book_provider_guard/status",headers:own,payload:{status}});assert.equal(response.statusCode,200,`expected ${status} to be accepted`);}assert.equal((await repository.getBooking("book_provider_guard"))?.status,"completed");await app.close();});
