import { spawn } from "node:child_process";

function milliseconds(value, label) {
  const match = String(value || "").trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
  if (!match) throw new Error(`${label} must be a duration such as 500ms, 10s or 3m`);
  const unit = (match[2] || "ms").toLowerCase();
  return Math.ceil(Number(match[1]) * ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[unit]));
}

const [timeoutValue, killAfterValue, command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("Usage: run-with-timeout.mjs <timeout> <kill-after> <command> [...args]");
  process.exit(69);
}

let timeoutMs;
let killAfterMs;
try {
  timeoutMs = milliseconds(timeoutValue, "timeout");
  killAfterMs = milliseconds(killAfterValue, "kill-after");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(69);
}

const child = spawn(command, args, { env: process.env, stdio: "inherit" });
let timedOut = false;
let forceTimer;
const timer = setTimeout(() => {
  timedOut = true;
  console.error(`Command exceeded ${timeoutValue}; sending SIGTERM.`);
  child.kill("SIGTERM");
  forceTimer = setTimeout(() => child.kill("SIGKILL"), killAfterMs);
}, timeoutMs);

child.once("error", (error) => {
  clearTimeout(timer);
  if (forceTimer) clearTimeout(forceTimer);
  console.error(`Unable to start bounded command: ${error.message}`);
  process.exit(69);
});

child.once("exit", (code, signal) => {
  clearTimeout(timer);
  if (forceTimer) clearTimeout(forceTimer);
  if (timedOut) process.exit(124);
  if (signal) {
    console.error(`Command stopped by ${signal}.`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
