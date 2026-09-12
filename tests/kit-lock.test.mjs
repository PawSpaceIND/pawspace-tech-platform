import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { DEFAULT_THEME } from "../app/mobile-app/theme-config.ts";

test("brand-lock carries Happier Pets kit cream token and does not rewrite money logic", async () => {
  assert.equal(DEFAULT_THEME, "emerald");
  const brandLock = await readFile(new URL("../app/brand-lock.css", import.meta.url), "utf8");
  const appearance = await readFile(new URL("../app/components/pawspace-appearance.tsx", import.meta.url), "utf8");
  assert.match(brandLock, /#01261f|#01261F/);
  assert.match(brandLock, /#e6b34e|#E6B34E/);
  assert.match(brandLock, /#fff8ee|#FFF8EE/);
  assert.doesNotMatch(brandLock, /razorpay|payout|webhook/i);
  assert.match(appearance, /Make PawSpace yours/);
});
