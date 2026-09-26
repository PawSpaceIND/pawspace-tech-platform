/*
 * Staging master E2E run 36243387701 (26 Sep 2026) showed internal wording to V2 Dog Training customers:
 * the confirmation read "…now share one canonical identity" and "Canonical scheduler assignment", the
 * price card read "₹500 sandbox amount due now · live money disabled", the booking page listed sessions as
 * "— locked" and said "Payment: captured" while half the programme price was still due, and the goal buttons
 * sat inside the "Dogs" button group, so assistive tech (and the test) read them as dogs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { customerTrainingSessionStatus, trainingSessionCount } from "../lib/training-session-status.ts";

test("customers see sessions as reserved, never as locked", () => {
  assert.equal(customerTrainingSessionStatus("locked"), "reserved");
  assert.equal(customerTrainingSessionStatus("scheduled"), "reserved");
  assert.equal(customerTrainingSessionStatus("accepted"), "trainer confirmed");
  assert.equal(customerTrainingSessionStatus("on_the_way"), "trainer on the way");
  assert.equal(customerTrainingSessionStatus("in_session"), "in progress");
  assert.equal(customerTrainingSessionStatus("reschedule_requested"), "reschedule requested");
  assert.equal(customerTrainingSessionStatus("no_show"), "missed");
  assert.equal(customerTrainingSessionStatus("SOME_new_state"), "some new state", "an unknown state still reads as words");
  assert.equal(customerTrainingSessionStatus(undefined), "");
  assert.equal(trainingSessionCount(1), "1 session");
  assert.equal(trainingSessionCount(8), "8 sessions");
});

const page = readFileSync(new URL("../app/training/page.tsx", import.meta.url), "utf8");
const booking = readFileSync(new URL("../app/v2/booking/page.tsx", import.meta.url), "utf8");
const sessions = readFileSync(new URL("../app/v2/booking/training-sessions.tsx", import.meta.url), "utf8");

test("V2 Training keeps internal wording on the /training UAT route only", () => {
  for (const internal of ["now share one canonical identity", "Canonical scheduler assignment", "sandbox amount due now · live money disabled", "The browser no longer invents a plan", "Loading canonical Training catalogue"]) {
    const at = page.indexOf(internal);
    assert.ok(at > 0, `${internal} is still shown on the UAT route`);
    // Each internal phrase is the non-V2 arm of a routeScope==="v2" choice.
    assert.match(page.slice(Math.max(0, at - 400), at), /routeScope==="v2"\?/, `${internal} must sit behind the V2 check`);
  }
  assert.match(page, /\$\{money\(currentQuote\.amountDueNow\)\} due now · \$\{money\(currentQuote\.totalAmount-currentQuote\.amountDueNow\)\} before your final session/);
  assert.match(page, /\{routeScope!=="v2"&&<small>\{session\.id\} · trainer \{session\.provider_id\}<\/small>\}/, "V2 hides session and provider ids");
});

test("the goal buttons are outside the Dogs button group", () => {
  const group = page.indexOf('role="group" aria-labelledby="training-dogs-label"');
  const goals = page.indexOf("What should training focus on?");
  assert.ok(group > 0 && goals > group);
  // Balance the <div> tags from the group's opening tag: the group must close before the goals fieldset.
  let depth = 0, closedAt = -1;
  for (const match of page.slice(group - 5).matchAll(/<div\b|<\/div>/g)) {
    depth += match[0] === "</div>" ? -1 : 1;
    if (depth === 0) { closedAt = group - 5 + match.index; break; }
  }
  assert.ok(closedAt > 0 && closedAt < goals, "the Dogs group closes before the goals fieldset");
});

test("the V2 booking page shows what is paid and what is due, and sessions in customer words", () => {
  assert.match(booking, /balanceStage&&record\.amountDueNow>0\?`Paid \$\{money\(/);
  assert.match(booking, /captured:"paid"/);
  assert.match(booking, /<div className=\{styles\.actions\}>\{manage&&/, "Manage service and Refresh status are laid out apart");
  assert.match(sessions, /customerTrainingSessionStatus\(session\.status\)/);
  assert.doesNotMatch(sessions, /session\.status\.replaceAll/);
});
