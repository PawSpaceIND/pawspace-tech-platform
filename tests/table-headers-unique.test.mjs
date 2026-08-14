import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Every table on a console screen builds its header row the same way:
//
//   {["Booking","Package","Payment", …].map(h => <th key={h}>{h}</th>)}
//
// so a repeated label is two bugs at once. React sees two children with the same key and warns, and
// the reader sees a column labelled as something it is not - /team/finance had "Booking" twice, where
// the third column actually renders booking_status.
//
// The browser smoke catches the React warning, but only on a screen it can reach with rows in it:
// signed in, with data, past every empty state. That leaves most of these arrays unvisited on any
// given run. This is the cheap half of the pair - it reads the literal arrays, so it covers every
// page whether or not a run happens to render it.
//
// It is a source check on purpose, and it is not standing in for a behaviour test: the behaviour is
// already driven by tests/e2e/persona-smoke.mjs. What it adds is reach.
// ---------------------------------------------------------------------------

/** Arrays of two or more string literals immediately followed by .map( - the header-row shape. */
const HEADER_ROW = /\[((?:\s*"[^"]*"\s*,){1,}\s*"[^"]*"\s*)\]\s*\.map\(/g;

async function pages(root = "app") {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await pages(full)));
    else if (entry.name.endsWith(".tsx")) found.push(full);
  }
  return found;
}

test("no table header row repeats a label, so React keys stay unique and no column lies", async () => {
  const duplicates = [];
  let arraysChecked = 0;

  for (const file of await pages()) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(HEADER_ROW)) {
      // Only the arrays whose .map() keys a JSX element on the label. A repeat there is always a key
      // collision, whether the element is a <th>, a chip or a card - so the check reaches further
      // than the table it was written for. An array mapped without a key can repeat harmlessly.
      const after = source.slice(match.index + match[0].length, match.index + match[0].length + 600);
      if (!/key=\{/.test(after)) continue;
      arraysChecked += 1;
      const labels = [...match[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
      const seen = new Set();
      const repeated = labels.filter((label) => (seen.has(label) ? true : (seen.add(label), false)));
      if (repeated.length) {
        const line = source.slice(0, match.index).split("\n").length;
        duplicates.push(`${file}:${line} repeats ${[...new Set(repeated)].map((r) => `"${r}"`).join(", ")} in [${labels.join(", ")}]`);
      }
    }
  }

  assert.ok(arraysChecked >= 12, `expected to find the keyed label rows across app/, found only ${arraysChecked}`);
  assert.deepEqual(duplicates, [], `a table header row repeats a label:\n  ${duplicates.join("\n  ")}`);
});
