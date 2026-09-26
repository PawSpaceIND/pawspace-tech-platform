/*
 * CRM "Send booking link" for Training leads (founder decision 26 Sep 2026). Staff assisted booking covers
 * Grooming only, so a Training lead gets the customer booking link: staff copy it or open their own WhatsApp
 * with it. PawSpace itself sends nothing, and the link opens the ordinary customer Training booking.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { trainingBookingLinkMessage, trainingBookingWhatsAppUrl } = await import("../lib/training-booking-link.ts");
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the message greets the lead by first name and links the customer Training booking page", () => {
  const message = trainingBookingLinkMessage("  Asha   Rao ", "https://pawspace.in/");
  assert.match(message, /^Hi Asha, here is your PawSpace Dog Training booking link: https:\/\/pawspace\.in\/v2\/training\?source=crm\n/);
  assert.match(message, /pay in full or 50% now\.$/);
  assert.match(trainingBookingLinkMessage("", "https://pawspace.in"), /^Hi there,/);
});

test("WhatsApp is offered only for a full Indian mobile number, with the message encoded", () => {
  assert.equal(trainingBookingWhatsAppUrl("+91 98450 12345", "Hi & welcome"), "https://wa.me/919845012345?text=Hi%20%26%20welcome");
  assert.equal(trainingBookingWhatsAppUrl("09845012345", "x"), "https://wa.me/919845012345?text=x", "the last ten digits are the mobile");
  assert.equal(trainingBookingWhatsAppUrl("98450", "x"), null, "a partial number gets no WhatsApp link");
  assert.equal(trainingBookingWhatsAppUrl("4123 4567", "x"), null, "a short landline gets no WhatsApp link");
});

test("the CRM shows the link only on a Training opportunity, and the button sends nothing itself", () => {
  const page = read("app/crm/page.tsx");
  assert.match(page, /\{\/training\/i\.test\(selected\.opportunity\)&&<TrainingBookingLink name=\{selected\.name\} phone=\{selected\.phone\}\/>\}/);
  const link = read("app/crm/training-booking-link.tsx");
  assert.match(link, /trainingBookingLinkMessage\(name, window\.location\.origin\)/);
  assert.doesNotMatch(link, /fetch\(|\/api\//, "no server call: nothing is sent on the customer's behalf");
});
