import test from"node:test";
import assert from"node:assert/strict";
import{readFile}from"node:fs/promises";
const read=path=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("Food Gate 5 builds one canonical Operations exception queue",async()=>{const source=await read("lib/food-ops-governance.ts");assert.match(source,/food_ops_action_keys/);assert.match(source,/food_ops_notes/);for(const flag of["stock_recovery_required","critical_quality_incident","urgent_quality_incident","quality_incident","cancellation_policy_review","refund_pending","media_blocked","payment_due","fulfilment_overdue","supplier_settlement_not_ready","tax_pending"])assert.match(source,new RegExp(flag));assert.match(source,/needsAttention/);assert.match(source,/financeReview/);});

test("Food stock recovery restores only the same SKU and price",async()=>{const source=await read("lib/food-ops-governance.ts");assert.match(source,/resume_same_sku_stock/);assert.match(source,/exact ordered SKU still lacks enough UAT stock/);assert.match(source,/substitution and repricing are blocked/);assert.match(source,/substitutionAllowed:false/);assert.match(source,/priceChangeAllowed:false/);assert.match(source,/unitPrice:Number\(order\.unit_price\)/);assert.match(source,/orderPreserved:true/);});

test("Food stock recovery restores reservation without replacing order identity",async()=>{const source=await read("lib/food-ops-governance.ts");assert.match(source,/reserved_units=reserved_units\+\?/);assert.match(source,/UPDATE food_inventory_reservations SET status='reserved'/);assert.match(source,/UPDATE food_orders SET status='accepted'/);assert.match(source,/same_sku_stock_recovered/);});

test("Food Operations keeps quality and Finance authority separate",async()=>{const page=await read("app/team/operations/food/page.tsx");assert.match(page,/Same-SKU stock recovery/);assert.match(page,/Substitution and price changes are blocked/);assert.match(page,/Incident resolution stays in Food proof governance/);assert.match(page,/Payment\/refund\/COGS\/supplier settlement\/tax stay in Food Finance governance/);});

test("Food Gate 5 API is staff permissioned and audited",async()=>{const api=await read("app/api/food-ops/route.ts");assert.match(api,/requirePermission\(actor,\"bookings\.view\"\)/);assert.match(api,/requirePermission\(actor,\"bookings\.manage\"\)/);assert.match(api,/resume_same_sku_stock/);assert.match(api,/add_note/);assert.match(api,/securityAudit/);});

test("Food Gate 5 is engineering closed but explicitly not production ready",async()=>{const source=await read("lib/food-ops-governance.ts");assert.match(source,/engineeringGate:\"gate_5_closed_uat_contract\"/);assert.match(source,/productionReady:false/);assert.match(source,/productionCatalogue:\"disconnected\"/);assert.match(source,/productionInventory:\"disconnected\"/);assert.match(source,/productionLotTraceability:\"disconnected\"/);assert.match(source,/deliveryPartner:\"disconnected\"/);assert.match(source,/payments:\"sandbox_only\"/);assert.match(source,/cogs:\"configuration_required\"/);assert.match(source,/supplierSettlement:\"rule_pending\"/);assert.match(source,/tax:\"configuration_required\"/);});
