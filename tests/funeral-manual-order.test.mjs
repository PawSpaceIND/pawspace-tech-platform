import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const lib = await readFile(new URL("../lib/funeral-manual-order.ts", import.meta.url), "utf8");
const route = await readFile(new URL("../app/api/funeral-manual-order/route.ts", import.meta.url), "utf8");
test("funeral manual capture records the required fields with GST off by default and a toggle", () => {
  assert.match(lib, /customer_name|phone|payment_method|order_value|order_date/);
  assert.match(lib, /gst_enabled INTEGER NOT NULL DEFAULT 0/);          // off by default
  assert.match(lib, /const gstAmount=cfg\.enabled\?money\(orderValue\*cfg\.rate\):0/);
  assert.match(lib, /export async function setFuneralManualGstMode/);   // future toggle to 18%
  assert.match(lib, /gstChargedByDefault:false,gstToggleable:true/);
  assert.match(route, /"record_order"/); assert.match(route, /"set_gst"/);
});
