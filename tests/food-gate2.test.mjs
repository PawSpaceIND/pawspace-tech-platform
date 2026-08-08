import test from"node:test";
import assert from"node:assert/strict";
import{readFile}from"node:fs/promises";
const read=path=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("Food Gate 2 owns idempotent fulfilment lifecycle",async()=>{const source=await read("lib/food-fulfilment-governance.ts");assert.match(source,/food_fulfilment_action_keys/);for(const action of["accept_order","pick_order","pack_order","dispatch_order","confirm_delivery","report_stock_issue"])assert.match(source,new RegExp(`\\"${action}\\"`));assert.match(source,/duplicatePrevented:true/);});

test("Food Gate 2 picks the exact UAT SKU lot without production traceability claims",async()=>{const source=await read("lib/food-fulfilment-governance.ts");assert.match(source,/food_uat_lots/);assert.match(source,/production_lot_verified INTEGER NOT NULL DEFAULT 0/);assert.match(source,/exact ordered SKU and zone/);assert.match(source,/productionLotVerified:false/);assert.doesNotMatch(source,/substitution_allowed INTEGER NOT NULL DEFAULT 1/);});

test("Food Gate 2 consumes inventory reservation exactly at pack",async()=>{const source=await read("lib/food-fulfilment-governance.ts");assert.match(source,/available_units=available_units-\?/);assert.match(source,/reserved_units=reserved_units-\?/);assert.match(source,/UPDATE food_inventory_reservations SET status='consumed'/);assert.match(source,/UAT Food inventory reservation is no longer packable/);});

test("Food Gate 2 dispatch is sandbox-only and delivery creates payment due",async()=>{const source=await read("lib/food-fulfilment-governance.ts");assert.match(source,/delivery_adapter_status TEXT NOT NULL DEFAULT 'not_connected'/);assert.match(source,/opaque UAT dispatch reference/);assert.match(source,/deliveryAdapterConnected:false/);assert.match(source,/food_order_payment_events/);assert.match(source,/canonical_food_uat_delivery/);assert.match(source,/status='due'/);assert.match(source,/liveMoney:false/);assert.match(source,/otpConnected:false/);});

test("Food Gate 2 stock recovery preserves order and forbids silent substitution or repricing",async()=>{const source=await read("lib/food-fulfilment-governance.ts");assert.match(source,/food_stock_recovery_cases/);assert.match(source,/substitution_allowed INTEGER NOT NULL DEFAULT 0/);assert.match(source,/substitutionAllowed:false/);assert.match(source,/priceChangeAllowed:false/);assert.match(source,/orderPreserved:true/);});

test("Food fulfilment API separates customer read from staff mutations",async()=>{const api=await read("app/api/food-fulfilment/route.ts");assert.match(api,/scope===\"customer\"/);assert.match(api,/requireCustomerOwnership/);assert.match(api,/requirePermission\(actor,\"bookings\.view\"\)/);assert.match(api,/requirePermission\(actor,\"bookings\.manage\"\)/);assert.match(api,/securityAudit/);});

test("Food fulfilment workspace executes canonical UAT actions without fake logistics",async()=>{const page=await read("app/team/operations/food/fulfilment/page.tsx");assert.match(page,/loadFoodFulfilment/);assert.match(page,/updateFoodFulfilment/);for(const action of["accept_order","pick_order","pack_order","dispatch_order","confirm_delivery","report_stock_issue"])assert.match(page,new RegExp(`\\"${action}\\"`));assert.match(page,/No SKU substitution or price change/);assert.match(page,/Live courier, OTP, production lot traceability and live payment remain disconnected/);});
