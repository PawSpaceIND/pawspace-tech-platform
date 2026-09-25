import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadCustomerFoodOrder } from "../lib/food-fulfilment-client.ts";
const [finance, fulfilment, page, client] = await Promise.all([
 readFile(new URL("../app/api/food-finance/route.ts", import.meta.url),"utf8"),
 readFile(new URL("../app/api/food-fulfilment/route.ts", import.meta.url),"utf8"),
 readFile(new URL("../app/food/manage/food-customer-management.tsx", import.meta.url),"utf8"),
 readFile(new URL("../lib/food-fulfilment-client.ts", import.meta.url),"utf8"),
]);
test("Food finance preserves safe governed 4xx detail",()=>{assert.match(finance,/error instanceof Response/);assert.match(finance,/Food finance request rejected/);assert.match(finance,/error\.status/)});
test("Customer Food snapshot exposes latest cancellation state",()=>{assert.match(fulfilment,/FROM food_cancellation_requests WHERE order_id=\?/);assert.match(fulfilment,/cancellation:cancellation\?\?null/);assert.match(client,/cancellation\?:Record<string,unknown>\|null/)});
test("Customer manage page shows and blocks duplicate pending cancellation",()=>{assert.match(page,/Cancellation review pending/);assert.match(page,/pendingCancellation/);assert.match(page,/disabled=\{busy\|\|pendingCancellation/)});


test("customer Food client executes the pending-cancellation projection", async () => {
  const originalFetch = globalThis.fetch;
  let requested = "";
  globalThis.fetch = async (url) => {
    requested = String(url);
    return new Response(JSON.stringify({data:[{
      id:"PS-UAT-FOOD-TEST", customer_id:"CUS-1", status:"uat_reserved", sku:"DOG-UAT",
      item_name:"Adult Dog Food · UAT", quantity:1,
      cancellation:{id:"CAN-1",status:"policy_review_required",reason:"UAT audit"}
    }]}), {status:200, headers:{"content-type":"application/json"}});
  };
  try {
    const rows = await loadCustomerFoodOrder("PS-UAT-FOOD-TEST");
    assert.match(requested, /scope=customer/);
    assert.equal(rows[0].cancellation?.status, "policy_review_required");
    assert.equal(rows[0].cancellation?.reason, "UAT audit");
  } finally { globalThis.fetch = originalFetch; }
});
