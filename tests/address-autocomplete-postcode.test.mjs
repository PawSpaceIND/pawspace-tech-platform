import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Google place resolution requests and returns structured postal code", async () => {
  const source = await read("lib/address-autocomplete.ts");
  assert.match(source, /formattedAddress,location,addressComponents/);
  assert.match(source, /types\?\.includes\("postal_code"\)/);
  assert.match(source, /pincode,/);
});

test("mobile address picker prefers structured Google postal code over formatted-address parsing", async () => {
  const source = await read("app/mobile-app/address-picker.tsx");
  assert.match(source, /place\.pincode\|\|pinFrom\(mapped\)/);
  assert.match(source, /\^\[1-9\]\\d\{5\}\$/);
  assert.match(source, /resolveServiceCoverage\(pincode\)/);
});
