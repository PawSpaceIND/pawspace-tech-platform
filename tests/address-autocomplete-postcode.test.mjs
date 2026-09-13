import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extractPostalCode } from "../lib/address-autocomplete.ts";

const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Google place resolution executes structured postal-code extraction", () => {
  assert.equal(extractPostalCode([
    { longText: "Bengaluru", types: ["locality"] },
    { longText: "560041", types: ["postal_code"] },
  ]), "560041");
  assert.equal(extractPostalCode([{ longText: "Jayanagar", types: ["sublocality"] }]), "");
});

test("Google place resolution requests addressComponents and returns pincode", async () => {
  const source = await read("lib/address-autocomplete.ts");
  assert.match(source, /formattedAddress,location,addressComponents/);
  assert.match(source, /pincode=extractPostalCode\(body\.addressComponents\)/);
});

test("mobile address picker prefers structured Google postal code over formatted-address parsing", async () => {
  const source = await read("app/mobile-app/address-picker.tsx");
  assert.match(source, /place\.pincode\|\|pinFrom\(mapped\)/);
  assert.match(source, /resolveServiceCoverage\(pincode\)/);
});
