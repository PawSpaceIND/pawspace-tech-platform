// Master suite runner. Suite selection: MASTER_SUITE env (workflow_dispatch input), else e2e/master/SUITE file.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fileSuite = existsSync(join(here, "SUITE")) ? readFileSync(join(here, "SUITE"), "utf8").trim() : "preflight";
const requested = String(process.env.MASTER_SUITE || fileSuite || "preflight").trim();
const available = readdirSync(join(here, "suites")).filter(f => f.endsWith(".mjs")).map(f => f.replace(/\.mjs$/, "")).sort();
const suites = requested === "all" ? ["preflight", ...available] : requested.split(",").map(s => s.trim()).filter(Boolean);
console.log(`Master E2E suites: ${suites.join(", ")}`);
let failures = 0;
for (const suite of suites) {
  const file = suite === "preflight" ? join(here, "preflight.mjs") : join(here, "suites", `${suite}.mjs`);
  if (!existsSync(file)) { console.log(`::warning::unknown suite ${suite}`); continue; }
  console.log(`\n===== ${suite} =====`);
  const started = Date.now();
  const r = spawnSync(process.execPath, [file], { stdio: "inherit", env: process.env, timeout: 40 * 60_000 });
  console.log(`===== ${suite} finished in ${Math.round((Date.now() - started) / 1000)}s (exit ${r.status}${r.signal ? ` signal ${r.signal}` : ""}) =====`);
  if (r.status !== 0) failures += 1;
}
// The suite records product defects as findings; a non-zero exit means the harness itself crashed.
process.exitCode = failures ? 1 : 0;
