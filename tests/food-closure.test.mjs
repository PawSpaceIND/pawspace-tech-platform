import test from"node:test";
import assert from"node:assert/strict";
import{readFile}from"node:fs/promises";
const read=path=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("Food closes one canonical customer to fulfilment to Ops to Finance path",async()=>{const customer=await read("app/food/canonical-food-page.tsx"),order=await read("app/api/food-orders/route.ts"),fulfilment=await read("app/team/operations/food/fulfilment/page.tsx"),ops=await read("app/team/operations/food/page.tsx"),finance=await read("app/team/finance/food/food-finance-workspace.tsx");assert.match(customer,/createCanonicalFoodOrder/);assert.match(order,/createFoodOrder/);assert.match(fulfilment,/updateFoodFulfilment/);assert.match(ops,/loadFoodOps/);assert.match(finance,/loadFoodFinance/);});

test("Food customer confirmation reaches canonical management and quality incidents",async()=>{const customer=await read("app/food/canonical-food-page.tsx"),manage=await read("app/food/manage/page.tsx");assert.match(customer,/\/food\/manage\?orderId=/);assert.match(customer,/Manage order/);assert.match(manage,/FoodCustomerIncidents/);});

test("Food stock recovery preserves exact SKU quantity and price",async()=>{const ops=await read("lib/food-ops-governance.ts");assert.match(ops,/resume_same_sku_stock/);assert.match(ops,/substitutionAllowed:false/);assert.match(ops,/priceChangeAllowed:false/);assert.match(ops,/unitPrice:Number\(order\.unit_price\)/);assert.match(ops,/orderPreserved:true/);});

test("Food gateway routes every gate to specialist authority",async()=>{const gateway=await read("lib/api-gateway.ts");for(const path of["food-commercial","food-orders","food-fulfilment","food-finance","food-proof","food-ops"])assert.match(gateway,new RegExp(`/api/${path}`));assert.match(gateway,/food-finance[\s\S]*finance\.view/);assert.match(gateway,/food-proof[\s\S]*acknowledge_incident[\s\S]*scheduling\.book/);assert.match(gateway,/food-ops[\s\S]*bookings\.manage/);});

test("Food closure remains UAT-only and does not claim production launch",async()=>{const doc=await read("docs/FOOD_CLOSURE_PLAN.md"),ops=await read("lib/food-ops-governance.ts"),food=await read("lib/food-governance.ts");assert.match(doc,/not a production-launch declaration/i);assert.match(ops,/productionReady:false/);assert.match(ops,/productionInventory:\"disconnected\"/);assert.match(ops,/productionLotTraceability:\"disconnected\"/);assert.match(food,/productionInventoryVerified:false/);});
