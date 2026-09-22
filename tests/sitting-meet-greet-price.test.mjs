/*
 * Owner decision 2026-09-22 (decision 1 of 10) — the Sitting Meet & Greet price is ₹499 everywhere the
 * customer sees a price: the option card, the review line and the bill.
 *
 * One screen gave three different answers for the same thing. The option card said ₹500 (twice). The
 * review line and the bill said ₹0, because `const meetFee = 0` sat above them. And the split-payment
 * note told the customer "The ₹500 meeting fee is collected now", which was wrong twice over: the price
 * is ₹499, and nothing is collected — a Meet & Greet is its own request with its own price
 * (meet_greet_requests.price_charged) and never joins the stay's quote, so the booking total neither
 * includes it nor splits it.
 *
 * The rule itself is executed here. The screen is checked for the thing that stops the split returning:
 * it reads the price from lib/meet-and-greet.ts and writes no Meet & Greet figure of its own.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { meetGreetPrice } from "../lib/meet-and-greet.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
/* Comments quote the old ₹500 copy to explain the defect; they are not what the customer reads. */
const withoutComments = (source) => source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "");

test("a Sitting house visit is priced ₹499, and a phone call is free", () => {
  assert.equal(meetGreetPrice("house_visit", 1).amount, 499);
  assert.equal(meetGreetPrice("house_visit", 4).amount, 499, "still ₹499 right up to the waiver threshold");
  assert.equal(meetGreetPrice("house_visit", 1).waived, false);
  assert.equal(meetGreetPrice("phone", 1).amount, 0, "a call has never cost anything");
  assert.notEqual(meetGreetPrice("house_visit", 1).amount, 500, "₹500 was the defect, not the price");
});

test("the long-stay waiver is a waiver of ₹499, not a different price", () => {
  const waived = meetGreetPrice("house_visit", 5);
  assert.equal(waived.amount, 0, "the customer is not charged");
  assert.equal(waived.waived, true);
  assert.equal(waived.reason, "stay_5_days_or_more", "and the screen can say why, instead of showing a bare ₹0");
});

test("the booking screen takes the price from the rule and writes none of its own", async () => {
  const stays = withoutComments(await read("app/mobile-app/stay-flow.tsx"));

  assert.match(stays, /import \{ meetGreetPrice \} from "\.\.\/\.\.\/lib\/meet-and-greet"/, "one source for the price");
  assert.match(stays, /const meetFee = meetGreetPrice\("house_visit", 0\)\.amount/);
  assert.doesNotMatch(stays, /const meetFee = 0/, "the ₹0 that made the review line and the bill disagree with the card");
  assert.doesNotMatch(stays, /₹\s*\d/, "no rupee figure may be typed into this screen at all");
  assert.doesNotMatch(stays, /meeting fee is collected now/, "nothing is collected here");
});

test("all three places the customer sees the price read the same label", async () => {
  const stays = withoutComments(await read("app/mobile-app/stay-flow.tsx"));
  // The card, the review line and the bill. Three separate renders that used to disagree.
  const uses = [...stays.matchAll(/meetFeeLabel/g)];
  assert.ok(uses.length >= 4, `every customer-facing price must use the one label, found ${uses.length}`);
  assert.match(stays, /2-hour sitter Meet & Greet · \$\{meetFeeLabel\}/, "option card");
  assert.match(stays, /2-hour home Meet & Greet · \$\{meetFeeLabel\}/, "format picker");
  assert.match(stays, /2 hours · \$\{meetFeeLabel\}/, "review line");
  assert.match(stays, /\$\{meetFeeLabel\} · paid separately/, "bill line, which is not part of the booking total");
});

test("the waived case names the waiver instead of silently reading zero", async () => {
  const stays = withoutComments(await read("app/mobile-app/stay-flow.tsx"));
  assert.match(stays, /meetFeeWaived \? `\$\{money\(meetFee\)\} · waived for stays of 5 nights or more`/,
    "a silent ₹0 is what made the old screen unreadable; the price stays ₹499 and the waiver is named");
});

test("the split-payment note no longer claims a fee is taken at checkout", async () => {
  const stays = withoutComments(await read("app/mobile-app/stay-flow.tsx"));
  assert.match(stays, /arranged and paid separately from this/);
  assert.match(stays, /not part of the booking total and is not split 50\/50/);
});
