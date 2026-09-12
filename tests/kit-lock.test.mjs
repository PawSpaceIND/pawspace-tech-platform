import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("kit-lock overlay uses locked emerald cream gold and does not rewrite money logic", async () => {
  const kit = await readFile(new URL("../app/kit-lock.css", import.meta.url), "utf8");
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  const appearance = await readFile(new URL("../app/components/pawspace-appearance.tsx", import.meta.url), "utf8");
  assert.match(kit, /#01261f|#01261F/);
  assert.match(kit, /#e6b34e|#E6B34E/);
  assert.match(kit, /#fff8ee|#FFF8EE/);
  assert.match(kit, /Presentation only/);
  assert.doesNotMatch(kit, /razorpay|payout|webhook/i);
  assert.match(layout, /kit-lock\.css/);
  assert.match(appearance, /Make PawSpace yours/);
});
