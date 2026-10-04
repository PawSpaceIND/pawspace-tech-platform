import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { DEFAULT_THEME } from "../app/mobile-app/theme-config.ts";

test("brand-lock carries Happier Pets kit cream token and does not rewrite money logic", async () => {
  assert.equal(DEFAULT_THEME, "editorial");
  const brandLock = await readFile(new URL("../app/brand-lock.css", import.meta.url), "utf8");
  const appearance = await readFile(new URL("../app/components/pawspace-appearance.tsx", import.meta.url), "utf8");
  const art = await readFile(new URL("../app/mobile-app/service-art.ts", import.meta.url), "utf8");
  assert.match(brandLock, /--psu-emerald:\s*var\(--ui-brand-deep\)/);
  assert.match(brandLock, /--psu-gold:\s*var\(--ui-gold-soft\)/);
  assert.match(brandLock, /--kit-cream:\s*var\(--ui-canvas\)/);
  assert.doesNotMatch(brandLock, /razorpay|payout|webhook/i);
  assert.match(appearance, /Make PawSpace yours/);
  assert.match(art, /Shih Tzu/);
  assert.match(art, /Golden Retriever/);
});
