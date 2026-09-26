/*
 * CRM "Send booking link" for Training leads (founder decision 26 Sep 2026). Staff assisted booking covers
 * Grooming only, so a Training lead gets the customer booking link: staff copy it or open their own WhatsApp
 * with it. PawSpace itself sends nothing, and the link opens the ordinary customer Training booking.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the CRM offers the Training booking link only on a Training opportunity, beside Book this customer", () => {
  const page = read("app/crm/page.tsx");
  assert.match(page, /import TrainingBookingLink from "\.\/training-booking-link";/);
  assert.match(page, /Book this customer →<\/Link>\{\/training\/i\.test\(selected\.opportunity\)&&<TrainingBookingLink name=\{selected\.name\} phone=\{selected\.phone\}\/>\}/);
});

test("the link is the customer Training booking page, shared by staff, never sent or fetched by PawSpace", () => {
  const link = read("app/crm/training-booking-link.tsx");
  assert.match(link, /\$\{window\.location\.origin\}\/v2\/training\?source=crm/);
  assert.match(link, /https:\/\/wa\.me\/91\$\{digits\}\?text=\$\{encodeURIComponent\(bookingMessage\(name\)\)\}/);
  assert.match(link, /digits\.length === 10 &&/, "WhatsApp is offered only for a full 10-digit number");
  assert.doesNotMatch(link, /fetch\(|\/api\//, "no server call: nothing is sent on the customer's behalf");
});
