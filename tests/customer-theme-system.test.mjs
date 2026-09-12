import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("customer app offers Emerald kit and Brand book colours", async () => {
  const config = await readFile(new URL("../app/mobile-app/theme-config.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/mobile-app/page.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/mobile-app/mobile.module.css", import.meta.url), "utf8");
  const globals = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const brandLock = await readFile(new URL("../app/brand-lock.css", import.meta.url), "utf8");
  const appearance = await readFile(new URL("../app/components/pawspace-appearance.tsx", import.meta.url), "utf8");
  const brandBook = await readFile(new URL("../app/brand-book-theme.css", import.meta.url), "utf8");

  assert.match(config, /id:"emerald"/);
  assert.match(config, /id:"signature"/);
  assert.match(config, /resolveBrandTheme/);
  assert.match(config, /PLATFORM_THEME_STORAGE_KEY/);
  assert.doesNotMatch(config, /id:"midnight"/);
  assert.doesNotMatch(config, /id:"rose"/);
  assert.doesNotMatch(config, /id:"ocean"/);

  assert.match(globals, /\[data-pawspace-mobile="true"\]\[data-theme="emerald"\]/);
  assert.match(brandLock, /#01261f|#01261F/);
  assert.match(brandLock, /#e6b34e|#E6B34E/);
  assert.match(brandBook, /#894AED/);
  assert.match(brandBook, /#FFAF00/);
  assert.match(appearance, /resolveBrandTheme/);
  assert.match(appearance, /Make PawSpace yours/);

  assert.match(page, /data-pawspace-mobile="true"/);
  assert.match(page, /data-theme=\{theme\}/);
  assert.doesNotMatch(css, /\[data-theme=/, "theme palettes must not drift back into the component stylesheet");
  for (const mode of ["system", "light", "dark"]) assert.match(page, new RegExp(`\"${mode}\"`));
  assert.match(page, /prefers-color-scheme: dark/);
  assert.match(page, /localStorage\.setItem\(THEME_STORAGE_KEY/);
  assert.match(page, /localStorage\.setItem\(APPEARANCE_STORAGE_KEY/);
  assert.match(page, /Make PawSpace yours/);
  assert.match(globals, /\[data-pawspace-mobile="true"\]\[data-mode="dark"\]/);
  assert.match(css, /data-mode="dark"/);
});

test("customer theme changes appearance only, not commercial or service truth", async () => {
  const config = await readFile(new URL("../app/mobile-app/theme-config.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/mobile-app/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(config, /price|payment|eligib|booking|provider/i);
  assert.match(page, /Pet Taxi remains outside the active launch scope/);
  assert.match(page, /live SMS delivery, money movement and external notifications remain separately gated/);
});
