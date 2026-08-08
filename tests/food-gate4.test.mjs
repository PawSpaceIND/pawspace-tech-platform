import test from"node:test";
import assert from"node:assert/strict";
import{readFile}from"node:fs/promises";
const read=path=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("Food Gate 4 media grants are private short-lived and order/SKU/lot bound",async()=>{const source=await read("lib/food-proof-governance.ts");assert.match(source,/food_media_upload_grants/);assert.match(source,/food_media_order_bindings/);assert.match(source,/15\*60_000/);assert.match(source,/token_hash/);assert.match(source,/rawPublicUrl:false/);assert.match(source,/order and SKU/);assert.match(source,/canonical UAT lot/);});

test("Food Gate 4 enforces MIME size checksum scan and private proof",async()=>{const source=await read("lib/food-proof-governance.ts");for(const mime of["image/jpeg","image/png","image/webp"])assert.match(source,new RegExp(mime.replace("/","\\/")));assert.match(source,/10_000_000/);assert.match(source,/SHA-256 checksum/);assert.match(source,/scan_status/);assert.match(source,/access_status/);assert.match(source,/retention_status/);assert.match(source,/not clean private active proof/);});

test("Food package and delivery proof stay UAT lot honest",async()=>{const source=await read("lib/food-proof-governance.ts");assert.match(source,/record_package_proof/);assert.match(source,/record_delivery_proof/);assert.match(source,/food_package/);assert.match(source,/food_delivery/);assert.match(source,/productionLotVerified:false/);});

test("Food quality incidents preserve order and specialist money authority",async()=>{const source=await read("lib/food-proof-governance.ts");assert.match(source,/food_quality_incidents/);assert.match(source,/attention/);assert.match(source,/urgent/);assert.match(source,/critical/);assert.match(source,/ops_escalation/);assert.match(source,/orderPreserved:true/);assert.match(source,/automaticRefund:false/);assert.match(source,/automaticSupplierSettlementChange:false/);});

test("Food proof API separates customer acknowledgement from staff proof authority",async()=>{const api=await read("app/api/food-proof/route.ts");assert.match(api,/staffActions=new Set<FoodProofAction>/);assert.match(api,/customerActions=new Set<FoodProofAction>/);assert.match(api,/requireCustomerOwnership/);assert.match(api,/requirePermission\(actor,\"bookings\.manage\"\)/);assert.match(api,/securityAudit/);});

test("Food customer incident acknowledgement cannot change money",async()=>{const page=await read("app/food/manage/food-customer-incidents.tsx");assert.match(page,/scope:\"customer\"/);assert.match(page,/acknowledge_incident/);assert.match(page,/does not approve a refund, charge or supplier settlement change/);});

test("Food proof workspace does not claim production traceability or money authority",async()=>{const page=await read("app/team/operations/food/proof/page.tsx");assert.match(page,/Private proof contract/);assert.match(page,/production lot verified/);assert.match(page,/Production object storage\/scanner is not connected/);assert.match(page,/must not invent refunds, supplier settlement or production lot traceability/);});
