import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const [finance, fulfilment, page, client] = await Promise.all([
 readFile(new URL("../app/api/food-finance/route.ts", import.meta.url),"utf8"),
 readFile(new URL("../app/api/food-fulfilment/route.ts", import.meta.url),"utf8"),
 readFile(new URL("../app/food/manage/food-customer-management.tsx", import.meta.url),"utf8"),
 readFile(new URL("../lib/food-fulfilment-client.ts", import.meta.url),"utf8"),
]);
test("Food finance preserves safe governed 4xx detail",()=>{assert.match(finance,/error instanceof Response/);assert.match(finance,/Food finance request rejected/);assert.match(finance,/error\.status/)});
test("Customer Food snapshot exposes latest cancellation state",()=>{assert.match(fulfilment,/FROM food_cancellation_requests WHERE order_id=\?/);assert.match(fulfilment,/cancellation:cancellation\?\?null/);assert.match(client,/cancellation\?:Record<string,unknown>\|null/)});
test("Customer manage page shows and blocks duplicate pending cancellation",()=>{assert.match(page,/Cancellation review pending/);assert.match(page,/pendingCancellation/);assert.match(page,/disabled=\{busy\|\|pendingCancellation/)});
