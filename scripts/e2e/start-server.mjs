import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";

// Node's detached child creates the process group used by run-hardened.sh cleanup on macOS/Linux.
// macOS does not ship the `setsid` executable previously required by that runner.
const log = openSync(process.argv[2], "a");
const child = spawn("bash", ["scripts/e2e/serve-hardened.sh"], {
  detached: true,
  env: { ...process.env, E2E_SKIP_BUILD: "1" },
  stdio: ["ignore", log, log],
});
closeSync(log);
child.once("error", error => { console.error(error.message); process.exitCode = 1; });
child.once("spawn", () => { console.log(child.pid); child.unref(); });
