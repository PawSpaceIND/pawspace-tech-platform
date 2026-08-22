import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__LEAK1_DB__", "__LEAK1_ENV__");

const { authError, authFailure } = await import("../lib/server-auth.ts");

test("unexpected API exceptions are logged internally but return only the generic fallback", async () => {
  const internalDetail = "SQLITE_CONSTRAINT secret_table.customer_email";
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    const response = authError(new Error(internalDetail), "Scheduling failed");
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.deepEqual(body, { error: "Scheduling failed" });
    assert.doesNotMatch(JSON.stringify(body), /SQLITE_CONSTRAINT|secret_table|customer_email/);
    assert.equal(logged.length, 1, "the original exception must still be available to server-side logs");
    assert.match(String(logged[0][0]), /unexpected error/i);
    assert.equal(logged[0][1] instanceof Error, true);
  } finally {
    console.error = originalError;
  }
});

test("intentional governed HTTP responses retain their status and safe body", async () => {
  const governed = authFailure("Customer ownership denied", 403);
  const response = authError(governed, "Scheduling failed");
  assert.equal(response, governed);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: "Customer ownership denied" });
});

test("an arbitrary thrown 500 Response cannot bypass redaction", async () => {
  const internalDetail = "SQLITE_CONSTRAINT secret_table.customer_email";
  const unsafe = Response.json({ error: internalDetail }, { status: 500 });
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = authError(unsafe, "Request failed");
    assert.notEqual(response, unsafe);
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.deepEqual(body, { error: "Request failed" });
    assert.doesNotMatch(JSON.stringify(body), /SQLITE_CONSTRAINT|secret_table|customer_email/);
  } finally {
    console.error = originalError;
  }
});

test("scheduling GET uses the shared redactor instead of echoing error.message", () => {
  const route = fs.readFileSync(new URL("../app/api/uat-scheduling/route.ts", import.meta.url), "utf8");
  assert.match(route, /catch\(error\)\{return authError\(error,"Unable to load the scheduling day board"\);\}\}/);
  assert.doesNotMatch(route, /error instanceof Error\?error\.message/);
});
