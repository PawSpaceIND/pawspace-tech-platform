import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// An empty screen and a broken screen look identical to a tester. That is not a
// theory: the founder sent screenshots of /team/subscriptions and /team/marketing
// as evidence the platform was broken, when both modules were working correctly
// and simply had nothing to show. Every hour spent chasing that was wasted.
//
// So a screen with no data must answer three questions: what is this for, what
// creates the first record, and where do I go to make one. A bare grey sentence
// answers none of them.
// ---------------------------------------------------------------------------
const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** The empty states a tester is most likely to hit first. */
const SCREENS = [
  { path: "app/team/sales/page.tsx", marker: "No customer records yet" },
  { path: "app/team/daily-revenue/page.tsx", marker: "No opportunities generated yet" },
  { path: "app/team/marketing/page.tsx", marker: "No governed campaigns yet" },
  { path: "app/team/subscriptions/page.tsx", marker: "No wallet loaded" },
];

test("every high-traffic empty state explains itself instead of stopping at a full stop", () => {
  const thin = [];
  for (const screen of SCREENS) {
    const source = read(screen.path);
    const index = source.indexOf(screen.marker);
    assert.ok(index >= 0, `${screen.path} should still contain the empty state "${screen.marker}"`);
    // Take the rendered text that follows the marker, up to the end of that element.
    const tail = source.slice(index, index + 600);
    const rendered = tail.split(/<\/(?:p|EmptyState|div)>|\/>/)[0];
    // "No X yet." on its own is ~20 characters. An explanation is not.
    if (rendered.replace(/\s+/g, " ").length < 90) thin.push(`${screen.path}: "${rendered.trim().slice(0, 60)}"`);
  }
  assert.deepEqual(thin, [],
    "these empty states stop at a full stop - say what the screen is for and what creates the first record");
});

test("the empty state tells the reader what to do next, not just what is missing", () => {
  const silent = [];
  for (const screen of SCREENS) {
    const source = read(screen.path);
    const tail = source.slice(source.indexOf(screen.marker), source.indexOf(screen.marker) + 700);
    // Either a link to the screen that creates the record, or an instruction naming the action.
    const actionable = /href="\/[a-z/-]+"/.test(tail)
      || /\b(Use the form|Enter a customer|Snapshot a campaign|configured under|added in the CRM)\b/i.test(tail);
    if (!actionable) silent.push(screen.path);
  }
  assert.deepEqual(silent, [],
    "these empty states describe the absence without telling the reader how to fill it");
});

test("the shared EmptyState component takes a body and an action, not just a title", () => {
  // A component that only accepts a title would guarantee bare empty states everywhere it is used.
  const component = read("app/components/ui/EmptyState.tsx");
  for (const prop of ["title", "body", "action"]) {
    assert.match(component, new RegExp(`${prop}\\??:`), `EmptyState must accept "${prop}"`);
  }
  assert.match(component, /\{action\}/, "the action must actually render");
});

test("no empty state claims data is loading forever, or blames the reader", () => {
  // Wording matters: "no records" is a fact about the database, not a fault of the person reading.
  for (const screen of SCREENS) {
    const source = read(screen.path);
    const tail = source.slice(source.indexOf(screen.marker), source.indexOf(screen.marker) + 700);
    assert.doesNotMatch(tail, /\berror\b/i, `${screen.path}: an empty result is not an error`);
    assert.doesNotMatch(tail, /you (?:did not|failed|forgot)/i, `${screen.path}: do not blame the reader`);
  }
});
