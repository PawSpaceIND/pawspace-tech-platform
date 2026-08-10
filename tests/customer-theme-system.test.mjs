import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("customer app exposes five premium themes and appearance modes", async () => {
  const config = await readFile(new URL("../app/mobile-app/theme-config.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/mobile-app/page.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/mobile-app/mobile.module.css", import.meta.url), "utf8");
  for (const theme of ["signature", "midnight", "sage", "rose", "ocean"]) {
    assert.match(config, new RegExp(`id:\"${theme}\"`));
    assert.match(css, new RegExp(`data-theme=\\\"${theme}\\\"`));
  }
  for (const mode of ["system", "light", "dark"]) assert.match(page, new RegExp(`\\\"${mode}\\\"`));
  assert.match(page, /prefers-color-scheme: dark/);
  assert.match(page, /localStorage\.setItem\(THEME_STORAGE_KEY/);
  assert.match(page, /localStorage\.setItem\(APPEARANCE_STORAGE_KEY/);
  assert.match(page, /Make PawSpace yours/);
  assert.match(css, /data-mode=\"dark\"/);
});

test("customer theme changes appearance only, not commercial or service truth", async () => {
  const config = await readFile(new URL("../app/mobile-app/theme-config.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/mobile-app/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(config, /price|payment|eligib|booking|provider/i);
  assert.match(page, /Pet Taxi remains outside the active launch scope/);
  assert.match(page, /live OTP, money movement and external notifications remain separately gated/);
});
