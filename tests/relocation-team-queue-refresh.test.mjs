/**
 * CUST-L-D03 (case-list half). `/team/relocation` loads its case queue once on mount and never
 * touched it again from an action's response, so the aside kept showing a case's PRE-action status
 * ("documents_pending") after the detail pane had already moved on ("quote_sent"). The fix reflects a
 * mutated case's new status into the queue from the same response the detail pane already uses.
 *
 * `react-dom/server` only renders a component's INITIAL, pre-effect state (see
 * tests/ptja-p1-tsx-render-harness.test.mjs), so the queue refresh itself — which only happens after a
 * button click, driven by React state — cannot be observed by rendering the page here. What IS pinned:
 * the pure merge function the page's `act()` calls, and that the page's source really calls it (so this
 * test goes red if the wiring is ever removed, not just if the helper's own logic regresses).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__RELO_QUEUE_DB__", "__RELO_QUEUE_ENV__");

const client = await import("../lib/relocation-client.ts");

test("mergeRelocationQueueStatus replaces only the mutated case's status, immutably", () => {
  const queue = [
    { id: "RLC-AAA", status: "documents_pending" },
    { id: "RLC-BBB", status: "lead" },
  ];
  const updated = { id: "RLC-AAA", status: "quote_sent", customer_id: "CUST-1", documents: [], milestones: [], refunds: [], events: [] };

  const merged = client.mergeRelocationQueueStatus(queue, updated);

  assert.notEqual(merged, queue, "a new array is returned");
  assert.equal(merged.find((row) => row.id === "RLC-AAA").status, "quote_sent", "the mutated case's status is refreshed");
  assert.equal(merged.find((row) => row.id === "RLC-BBB").status, "lead", "an unrelated row is untouched");
  assert.equal(queue.find((row) => row.id === "RLC-AAA").status, "documents_pending", "the original queue array is not mutated");
});

test("mergeRelocationQueueStatus is a no-op when the mutated case is not in the queue", () => {
  const queue = [{ id: "RLC-AAA", status: "lead" }];
  const updated = { id: "RLC-ZZZ", status: "quote_sent", customer_id: "CUST-1", documents: [], milestones: [], refunds: [], events: [] };
  const merged = client.mergeRelocationQueueStatus(queue, updated);
  assert.deepEqual(merged, queue);
});

test("the staff relocation page wires the queue merge into every action response", () => {
  const source = readFileSync(new URL("../app/team/relocation/page.tsx", import.meta.url), "utf8");
  assert.match(source, /mergeRelocationQueueStatus/, "the page imports/uses the merge helper");
  // The action handler must call setQueue with the merge applied to the SAME response it hands to
  // setActive — a queue refetch or a second endpoint call would not be the minimal, atomic fix.
  assert.match(
    source,
    /const updated=await updateRelocationCase\(\{caseId:active\.id,\.\.\.input\}\);setActive\(updated\);setQueue\(current=>mergeRelocationQueueStatus\(current,updated\)\)/,
    "act() refreshes both the detail pane and the queue from the one mutation response",
  );
});

test("the staff relocation page still renders its initial 'select a case' state", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const { default: TeamRelocation } = await import("../app/team/relocation/page.tsx");
  const html = renderToStaticMarkup(React.createElement(TeamRelocation));
  assert.match(html, /Select a case/);
});
