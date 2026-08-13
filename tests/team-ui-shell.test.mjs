import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// "The UI is not built and it comes as blank."
//
// Three separate defects sat behind that, none of them in the data layer:
//   1. /team/revenue-mission had NO styling at all — it rendered as raw browser-default text on a
//      white page, with no shell, no cards and no way to navigate anywhere.
//   2. /team/ai/analytics put every card inside `{data && ...}`, so the page was a header on an
//      empty background until the fetch resolved — and permanently if it failed.
//   3. The whole AI module was orphaned: nothing under /team linked to /team/ai, so it was
//      reachable only by typing the URL.
//
// The design kit (Card, StatCard, Badge, PageHeader, EmptyState) already existed; the pages simply
// did not use it. These tests pin the fixes.
// ---------------------------------------------------------------------------
const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const SHELL_PAGES = ["app/team/revenue-mission/page.tsx", "app/team/ai/analytics/page.tsx"];

// These two pages were rebuilt on a shell this branch introduced (TeamShell). Meanwhile nine other
// consoles landed on OpsShell + team-console.module.css, which carries a persistent sidebar marking
// the active route — something TeamShell never had. Two shells for one workspace is worse than either,
// so TeamShell was retired and these two moved across. The guard now enforces the surviving one.
test("every internal console renders inside the ONE shared shell", () => {
  const consoles = [...SHELL_PAGES, "app/team/cases/page.tsx", "app/team/customer-experience/page.tsx", "app/team/people/page.tsx"];
  for (const file of consoles) {
    const source = read(file);
    assert.match(source, /OpsShell/, `${file} must render inside OpsShell`);
    assert.match(source, /team-console\.module\.css/, `${file} must use the shared console vocabulary, not its own styles`);
  }
});

test("the retired second shell is gone, not left behind for the next page to pick up", () => {
  assert.ok(!fs.existsSync("app/components/ui/TeamShell.tsx"), "TeamShell was consolidated into OpsShell");
  assert.ok(!fs.existsSync("app/components/ui/team-shell.module.css"), "and its stylesheet with it");
  assert.ok(!read("app/components/ui/index.ts").includes("TeamShell"), "the kit must not re-export a shell that no longer exists");
  // A shell is chrome; the kit keeps the content primitives every console shares.
  for (const kept of ["Button", "Card", "Badge", "StatCard", "PageHeader", "EmptyState"]) {
    assert.ok(read("app/components/ui/index.ts").includes(kept), `${kept} stays in the kit`);
  }
});

test("no Team page ships with zero styling the way revenue-mission did", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.name !== "page.tsx") continue;
      let source = fs.readFileSync(full, "utf8");
      // A page that only re-exports, or only mounts a workspace component, delegates its UI — follow
      // the delegate and judge that instead, so the guard measures what the browser actually renders.
      const reexport = source.match(/^\s*export\s*\{\s*default\s*\}\s*from\s*"([^"]+)"/m);
      const mount = source.match(/^\s*import\s+\w+\s*from\s*"(\.\/[^"]+)"/m);
      const delegate = reexport?.[1] || (!/<[a-z]/.test(source) ? mount?.[1] : null);
      if (delegate) {
        const base = path.resolve(path.dirname(full), delegate);
        const resolved = [`${base}.tsx`, path.join(base, "page.tsx")].find((candidate) => fs.existsSync(candidate));
        if (!resolved) { offenders.push(`${full} (delegates to ${delegate}, which does not exist)`); continue; }
        source = fs.readFileSync(resolved, "utf8");
      }
      const styled = /style=\{|className=|components\/ui/.test(source);
      if (!styled) offenders.push(full);
    }
  };
  walk(new URL("../app/team", import.meta.url).pathname);
  assert.deepEqual(offenders, [], `these Team pages render unstyled browser-default markup: ${offenders.join(", ")}`);
});

test("AI analytics renders its cards and navigation before the fetch resolves", () => {
  const source = read("app/team/ai/analytics/page.tsx");
  const grid = source.indexOf("styles.tiles");
  const guarded = source.indexOf("{data && <>");
  assert.ok(grid > 0, "the stat grid must exist");
  assert.ok(guarded === -1 || grid < guarded, "the headline cards must render outside the `data &&` guard, so the page is never a bare header");
  assert.match(source, /busy \? "…"/, "cards must show a loading placeholder rather than nothing");
  assert.match(source, /styles\.panelError/, "a failed load must surface as a visible alert");
  // The filters the API has always supported must be reachable from the screen.
  for (const control of ["channel", "from", "to"]) assert.ok(source.includes(`query.set("${control}"`), `the ${control} filter must be exposed`);
});

test("the AI workspace is reachable from the Team front door", () => {
  const teamHome = read("app/team/page.tsx");
  assert.match(teamHome, /href: "\/team\/ai"/, "Team home must link to the AI workspace — it previously linked nowhere near it");
  assert.match(teamHome, /aiRolloutStage/, "the AI card must show the real rollout stage, not a fixed label");
  const overview = read("lib/team-overview.ts");
  assert.match(overview, /FROM ai_handoffs WHERE status IN \('queued','staff_active'\)/, "the counter must come from real handoff rows");
  assert.match(overview, /FROM ai_audience_rollout WHERE id=1/);
});

test("every Team workspace card on the front door points at a page that exists", () => {
  const teamHome = read("app/team/page.tsx");
  const hrefs = [...teamHome.matchAll(/href: "(\/team[^"]*)"/g)].map((match) => match[1]);
  assert.ok(hrefs.length >= 8, "the front door should list the workspaces");
  for (const href of hrefs) {
    const target = new URL(`../app${href}/page.tsx`, import.meta.url).pathname;
    assert.ok(fs.existsSync(target), `${href} is linked from Team home but has no page`);
  }
});

test("the handoff screen opens on a live escalation instead of an arbitrary thread", () => {
  const page = read("app/team/ai/handoff/page.tsx");
  assert.match(page, /mode=queue/, "the page must ask for the escalation queue");
  assert.match(page, /const escalated = rows\.find/, "it must prefer a thread that actually has a handoff");
  assert.match(page, /Waiting for staff/, "the thread list must show which conversations are escalated");
  const lib = read("lib/ai-human-handoff.ts");
  assert.match(lib, /export async function listAiHandoffQueue/);
  assert.match(lib, /WHERE h\.status IN \('queued','staff_active'\)/, "the queue is live escalations only");
  assert.match(lib, /catch\(\(\)=>\(\{results:\[\] as Row\[\]\}\)\)/, "cold-DB safe: a fresh environment returns an empty queue, not an error");
});
