import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const files = ["app/driver/canonical-driver-page.tsx", "app/driver/recovery/page.tsx", "app/driver/proof/page.tsx"];

test("driver workspaces read query parameters after hydration", () => {
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /useQueryParameter\("bookingId"\)/, file);
    assert.doesNotMatch(source, /useState\(\(\)=>typeof window/, file);
  }
});

test("shared query hook keeps the server and first client render identical", () => {
  const source = fs.readFileSync("lib/use-query-parameter.ts", "utf8");
  assert.match(source, /useSyncExternalStore/);
  assert.match(source, /\(\) => ""/);
  assert.match(source, /window\.location\.search/);
});

test("client pages do not read query parameters during the hydration render", () => {
  const pages = fs.readdirSync("app", { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".tsx"));
  for (const file of pages) {
    const source = fs.readFileSync(`app/${file}`, "utf8");
    assert.doesNotMatch(source, /new URLSearchParams\(window\.location\.search\)/, file);
  }
});
