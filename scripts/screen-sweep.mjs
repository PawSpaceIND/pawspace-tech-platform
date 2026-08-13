// Opens EVERY route in a real browser and reports which screens are actually usable.
//
// Why a browser and not curl. Most staff screens are client components: the server sends a shell and
// the numbers arrive from fetch() after hydration. Every blank screen reported from staging so far was
// that shape — /team/ai/analytics rendered a header and nothing else because its cards sat inside
// `{data && ...}`. curl sees a 200 and some markup and calls it fine. A static test sees a file that
// imports the design kit and calls it fine. Neither can see an empty page. Only a browser that waits
// for the fetches can.
//
// What each route is judged on, after the network settles:
//   status          the HTTP status (and where a redirect landed)
//   apiFailures     any /api/* request the page made that returned >=400  <- the usual root cause
//   consoleErrors   uncaught errors, which is what a white screen really is
//   textLength      visible text; a page that is only a header scores very low
//   interactive     count of links/buttons/inputs/rows — is there anything to DO here
//   emptyStates     whether the page SAYS it is empty, which is a pass, not a failure
//
// The last one is the point. "No data yet" rendered deliberately is a healthy screen. A page that
// renders its title and then nothing is not. Distinguishing those two is the whole job, and it is why
// blank screens kept coming back from manual browsing instead of from a test.
//
// Usage:
//   npm run dev &                                   # or point --base at staging
//   node scripts/screen-sweep.mjs
//   node scripts/screen-sweep.mjs --base=https://pawspace-staging.example.workers.dev --cookie="..."
//   node scripts/screen-sweep.mjs --only=/team      # sweep one subtree
//   node scripts/screen-sweep.mjs --json=sweep.json # machine-readable, for diffing between runs
//
// Twelve customer and partner routes correctly refuse an anonymous call, so an unauthenticated sweep
// reports them NOT TESTED rather than passing them. --login signs in through the real
// /api/staging-login endpoint and reuses the cookie it sets, so those screens get covered without
// anyone copying a cookie out of DevTools:
//   node scripts/screen-sweep.mjs --login=pawspace-uat-2026 --as=founder@pawspace.in

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const arg = (name, fallback = "") => {
  const found = process.argv.find((item) => item.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const BASE = arg("base", "http://localhost:5173").replace(/\/$/, "");
const ONLY = arg("only");
const JSON_OUT = arg("json");
const COOKIE = arg("cookie");
const LOGIN_CODE = arg("login");          // UAT access code — the sweep signs itself in
const LOGIN_EMAIL = arg("as", "founder@pawspace.in");
const TIMEOUT = Number(arg("timeout", "20000"));

// Dynamic segments need a real value or the route 404s and tells us nothing. These are sampled from
// what the seeds actually contain, so a miss here is a genuine finding rather than a bad fixture.
const DYNAMIC_SAMPLES = { "[slug]": "grooming", "[breed]": "labrador-retriever", "[id]": "UATD-CUS-1" };
/** Routes reached via a sampled value. A 404 on one of these means the SAMPLE does not exist in this
 *  database — a fixture gap, not a missing page — so it must not be reported as a broken route. */
const DYNAMIC_ROUTES = new Set();

/** Every route the app serves, derived from the filesystem so a new page cannot escape the sweep. */
function discoverRoutes(root = "app") {
  const routes = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.name !== "page.tsx") continue;
      let route = `/${path.relative(root, dir).split(path.sep).join("/")}`;
      if (route === "/.") route = "/";
      // Route groups (folders in parentheses) do not appear in the URL.
      route = route.replace(/\/\([^/]+\)/g, "") || "/";
      let sampled = false;
      if (/\[[^\]]+\]/.test(route)) {
        for (const [token, sample] of Object.entries(DYNAMIC_SAMPLES)) {
          if (route.includes(token)) { route = route.replaceAll(token, sample); sampled = true; }
        }
      }
      if (/\[[^\]]+\]/.test(route)) continue; // an unsampled dynamic segment: skip rather than guess
      routes.push(route);
      if (sampled) DYNAMIC_ROUTES.add(route);
    }
  };
  walk(root);
  return [...new Set(routes)].sort();
}

// Does this screen SAY it has nothing to show? That is a pass, not a failure.
//
// This started as a curated phrase list and it was wrong three times running — it missed "Open with
// canonical bookingId", then "not yet linked to a provider", then "No enquiries submitted yet". Each
// miss reported a correctly-behaving page as broken. Enumerating wordings is unwinnable: every screen
// phrases it differently.
//
// So match the STRUCTURE instead. An honest empty state is a sentence that OPENS with a negation
// ("No enquiries submitted yet", "Nothing recorded", "Not measured") or with an instruction telling
// the tester what to supply ("Open with canonical bookingId", "Select a thread"). Sentence-initial is
// what makes this safe: a bare /\bnot\b/ anywhere in the text would match almost any prose.
const EMPTY_STATE_OPENERS = /^(no|none|nothing|not|never|neither|open|select|enter|provide|choose|pick|search|start|add|requires?|awaiting|pending|loading|configuration required)\b/i;

// A few states that do not open with one of those but still explain themselves plainly.
const EMPTY_STATE_PHRASES = [
  "not yet linked", "no provider record", "not attributable", "not measured", "not claimed",
  "not connected", "no booking selected", "is empty", "yet to be", "will appear here",
];

/** Every self-explaining sentence on the page. Empty result means the screen never says why it is bare. */
function detectEmptyStates(text) {
  const found = [];
  // Split on sentence and line boundaries, because these messages are often their own paragraph.
  for (const raw of text.split(/(?<=[.!?])\s+|\n+|\s{2,}/)) {
    const sentence = raw.trim();
    if (sentence.length < 3 || sentence.length > 200) continue;
    if (EMPTY_STATE_OPENERS.test(sentence)) found.push(sentence.slice(0, 80));
  }
  const lower = text.toLowerCase();
  for (const phrase of EMPTY_STATE_PHRASES) if (lower.includes(phrase)) found.push(phrase);
  return [...new Set(found)];
}

// Endpoints that answer 401 or 400 BY DESIGN when a page is opened without a session or a filter.
// /api/identity-session 401s for a signed-out visitor; the scope-required feeds 400 asking for their
// filter rather than dumping every row. Neither is a broken screen — but both mean the sweep has not
// actually tested that page yet, which is worth saying out loud rather than scoring as a pass.
const EXPECTED_WITHOUT_SESSION = [
  // NOT covered by a /staging-login staff cookie — that is a STAFF identity. These screens resolve a
  // customer or provider subject from pawspace_identity_session, which is issued by the app's own
  // OTP/assertion flow. Verified: signing the sweep in as founder@pawspace.in changes none of them.
  { pattern: /\/api\/identity-session/, status: 401, why: "needs a customer/provider session (pawspace_identity_session); a staff cookie will not do" },
  { pattern: /\/api\/staging-login/, status: 404, why: "UAT login is not enabled in this environment" },
  { pattern: /\/api\/(boarding-stays|partner-job-feed|walking-lifecycle|taxi-ops|food-fulfilment)/, status: 400, why: "asks for its filter instead of dumping every row" },
];

async function sweepRoute(page, route) {
  const apiFailures = [], consoleErrors = [], pageErrors = [];
  const onResponse = (response) => {
    const url = response.url();
    if (url.includes("/api/") && response.status() >= 400) apiFailures.push(`${response.status()} ${new URL(url).pathname}${new URL(url).search}`);
  };
  const onConsole = (message) => { if (message.type() === "error") consoleErrors.push(message.text().slice(0, 200)); };
  const onPageError = (error) => pageErrors.push(String(error.message).slice(0, 200));

  page.on("response", onResponse);
  page.on("console", onConsole);
  page.on("pageerror", onPageError);

  let status = 0, landed = route, failure = "";
  try {
    const response = await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    status = response?.status() ?? 0;
    // Give the client fetches a chance to land. networkidle is the whole reason this sweep sees what
    // curl cannot; a timeout here is itself a finding (a request that never settles).
    await page.waitForLoadState("networkidle", { timeout: TIMEOUT }).catch(() => { failure = "network never settled"; });
    landed = new URL(page.url()).pathname;
  } catch (error) {
    failure = String(error.message).split("\n")[0].slice(0, 160);
  }

  const measured = await page.evaluate(() => {
    // Keep the RAW innerText as well as the flattened one. Empty-state detection is sentence- and
    // line-aware, and innerText's newlines between block elements ARE those boundaries: flattening
    // first turned "Pet Taxi proof\nOpen with canonical bookingId." into one sentence starting with
    // "Pet", so the instruction stopped being sentence-initial and the page read as unexplained.
    const raw = document.body?.innerText || "";
    const text = raw.replace(/\s+/g, " ").trim();
    return {
      raw,
      text,
      textLength: text.length,
      interactive: document.querySelectorAll("a[href],button,input,select,textarea,tr td").length,
      // Counted separately from links: a page offering an input or a button gives the tester a way
      // forward, which a page of pure navigation does not. /team/finance/food looks sparse but has a
      // "Load" field, so it is usable; /food/manage has neither a field nor an explanation.
      formControls: document.querySelectorAll("button,input,select,textarea").length,
      headings: document.querySelectorAll("h1,h2,h3").length,
    };
  }).catch(() => ({ raw: "", text: "", textLength: 0, interactive: 0, formControls: 0, headings: 0 }));

  page.off("response", onResponse);
  page.off("console", onConsole);
  page.off("pageerror", onPageError);

  const emptyStates = detectEmptyStates(measured.raw);
  // Keep an excerpt of what the page actually said. Without it every finding needs a manual browser
  // visit to interpret — which is the loop this sweep exists to replace.
  return { route, status, landed, redirected: landed !== route, failure, apiFailures: [...new Set(apiFailures)], consoleErrors: [...new Set(consoleErrors)], pageErrors: [...new Set(pageErrors)], ...measured, emptyStates: emptyStates.slice(0, 3), excerpt: measured.text.slice(0, 300), text: undefined, raw: undefined };
}

/**
 * Turns measurements into a verdict. Ordered most to least severe, and deliberately treats a
 * self-declared empty state as PASSING — a screen that says "nothing recorded yet" is doing its job.
 */
function verdict(result) {
  if (result.status === 0 || result.failure.startsWith("page.goto")) return { level: "BROKEN", why: result.failure || "did not load" };
  if (result.status >= 500) return { level: "BROKEN", why: `HTTP ${result.status}` };
  if (result.pageErrors.length) return { level: "BROKEN", why: `uncaught: ${result.pageErrors[0]}` };
  if (result.status === 404) {
    return DYNAMIC_ROUTES.has(result.route)
      ? { level: "FIXTURE", why: "404 — the sampled value does not exist here; the page itself may be fine" }
      : { level: "MISSING", why: "HTTP 404" };
  }

  // Separate "this API is broken" from "this API correctly refused an anonymous or unfiltered call".
  const unexpected = result.apiFailures.filter((failure) => !EXPECTED_WITHOUT_SESSION.some((rule) => rule.pattern.test(failure) && failure.startsWith(String(rule.status))));
  if (unexpected.length) return { level: "DATA", why: `API ${unexpected.join(", ")}` };
  if (result.apiFailures.length) {
    const rule = EXPECTED_WITHOUT_SESSION.find((candidate) => result.apiFailures.some((failure) => candidate.pattern.test(failure)));
    return { level: "GATED", why: `${rule?.why || "gated"} — re-run with --cookie to test this properly` };
  }

  // The blank-screen test: almost no text, no form control offering a way forward, and no empty state.
  if (result.textLength < 120 && result.formControls === 0 && result.emptyStates.length === 0) return { level: "BLANK", why: `${result.textLength} chars, nothing to interact with, no explanation` };
  if (result.headings > 0 && result.textLength < 260 && result.emptyStates.length === 0 && result.formControls === 0) return { level: "THIN", why: `header plus ${result.textLength} chars, no empty state and no input — a tester cannot proceed from here` };
  if (result.failure) return { level: "SLOW", why: result.failure };
  if (result.consoleErrors.length) return { level: "NOISY", why: result.consoleErrors[0] };
  if (result.redirected) return { level: "OK", why: `redirects to ${result.landed}` };
  return { level: "OK", why: `${result.textLength} chars, ${result.interactive} interactive` };
}

const FAIL_LEVELS = new Set(["BROKEN", "MISSING", "DATA", "BLANK", "THIN"]);
// GATED is not a failure and not a pass: the route refused an anonymous call, correctly, so the sweep
// never saw the real screen. Reported separately so it cannot be mistaken for coverage.
const UNTESTED_LEVELS = new Set(["GATED", "FIXTURE"]);

async function main() {
  const routes = discoverRoutes().filter((route) => !ONLY || route.startsWith(ONLY));
  console.log(`Sweeping ${routes.length} route(s) at ${BASE}\n`);

  // This container ships Chromium at a pinned revision that will not match whatever the installed
  // playwright package expects, and it forbids downloading more. Point at the binary that is here.
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM,
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    ...fs.existsSync("/opt/pw-browsers") ? fs.readdirSync("/opt/pw-browsers").filter((name) => name.startsWith("chromium")).map((name) => `/opt/pw-browsers/${name}/chrome-linux/chrome`) : [],
  ].filter(Boolean);
  const executablePath = candidates.find((candidate) => fs.existsSync(candidate));
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (COOKIE) {
    const [name, ...rest] = COOKIE.split("=");
    await context.addCookies([{ name, value: rest.join("="), url: BASE }]);
  }
  // Sign in through the real endpoint rather than asking the operator for a cookie value. If this
  // fails, say so and carry on unauthenticated — the gated routes then report NOT TESTED, which is
  // honest, instead of the whole sweep aborting.
  if (LOGIN_CODE) {
    const response = await context.request.post(`${BASE}/api/staging-login`, { data: { action: "login", code: LOGIN_CODE, email: LOGIN_EMAIL } });
    if (response.ok()) {
      const cookies = await context.cookies(BASE);
      const session = cookies.find((item) => item.name === "pawspace_uat");
      console.log(session ? `Signed in as ${LOGIN_EMAIL} — gated routes will be covered.\n` : `Sign-in returned ${response.status()} but set no pawspace_uat cookie; continuing unauthenticated.\n`);
    } else {
      console.log(`Sign-in failed (HTTP ${response.status()}: ${(await response.text()).slice(0, 120)}). Continuing unauthenticated — gated routes will report NOT TESTED.\n`);
    }
  }

  const page = await context.newPage();

  const results = [];
  for (const route of routes) {
    const result = await sweepRoute(page, route);
    result.verdict = verdict(result);
    results.push(result);
    const mark = FAIL_LEVELS.has(result.verdict.level) ? "✗" : result.verdict.level === "OK" ? "✓" : "·";
    console.log(`${mark} ${result.verdict.level.padEnd(7)} ${route.padEnd(44)} ${result.verdict.why}`);
  }
  await browser.close();

  const failures = results.filter((item) => FAIL_LEVELS.has(item.verdict.level));
  const grouped = new Map();
  for (const item of failures) grouped.set(item.verdict.level, [...(grouped.get(item.verdict.level) || []), item]);

  console.log(`\n${"=".repeat(78)}`);
  console.log(`${results.length} routes · ${results.length - failures.length} usable · ${failures.length} need attention\n`);
  for (const [level, items] of grouped) {
    console.log(`${level} (${items.length})`);
    for (const item of items) console.log(`   ${item.route} — ${item.verdict.why}`);
    console.log();
  }
  if (!failures.length) console.log("Every route rendered real content, or said honestly why it had none.\n");

  const gated = results.filter((item) => UNTESTED_LEVELS.has(item.verdict.level));
  if (gated.length) {
    console.log(`NOT TESTED (${gated.length}) — the sweep did not reach the real screen for these:`);
    for (const item of gated) console.log(`   ${item.route} — ${item.verdict.why}`);
    console.log("   --login=<UAT access code> covers STAFF routes. A customer or provider screen needs");
    console.log("   --cookie=\"pawspace_identity_session=<token>\" from a real app sign-in; a staff cookie will not do.\n");
  }

  console.log("Levels: BROKEN did not load · MISSING 404 · DATA an API it calls failed");
  console.log("        BLANK nothing rendered · THIN a header and nothing else, with no empty state");
  console.log("        SLOW/NOISY worth a look but rendered · OK usable");

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ base: BASE, routes: results }, null, 2));
    console.log(`\nWrote ${JSON_OUT} — diff two runs to see what a change actually altered.`);
  }
  process.exit(failures.length ? 1 : 0);
}

export { discoverRoutes, verdict, detectEmptyStates, DYNAMIC_ROUTES, EMPTY_STATE_OPENERS, EMPTY_STATE_PHRASES, EXPECTED_WITHOUT_SESSION, FAIL_LEVELS, UNTESTED_LEVELS };

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error); process.exit(2); });
}
