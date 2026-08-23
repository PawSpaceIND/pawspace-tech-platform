import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__LEAK1_DB__", "__LEAK1_ENV__");

const { authError, authFailure } = await import("../lib/server-auth.ts");
const schedulingRoute = await import("../app/api/uat-scheduling/route.ts");

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

test("a forged governed-error header cannot bypass redaction", async () => {
  const internalDetail = "SQLITE_CONSTRAINT secret_table.customer_email";
  const unsafe = Response.json(
    { error: internalDetail },
    { status: 403, headers: { "x-pawspace-governed-error": "1" } },
  );
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = authError(unsafe, "Request failed");
    assert.notEqual(response, unsafe);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.deepEqual(body, { error: "Request failed" });
    assert.doesNotMatch(JSON.stringify(body), /SQLITE_CONSTRAINT|secret_table|customer_email/);
  } finally {
    console.error = originalError;
  }
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

test("scheduling GET behavior redacts an actual database-path failure", async () => {
  const internalDetail = "D1_ERROR no such table: secret_customer_table";
  const originalDb = globalThis.__LEAK1_DB__;
  const originalError = console.error;
  globalThis.__LEAK1_DB__ = {
    prepare() { throw new Error(internalDetail); },
    batch() { throw new Error(internalDetail); },
    exec() { throw new Error(internalDetail); },
  };
  console.error = () => {};
  try {
    const response = await schedulingRoute.GET(new Request("http://localhost/api/uat-scheduling?date=2026-08-22"));
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.deepEqual(body, { error: "Unable to load the scheduling day board" });
    assert.doesNotMatch(JSON.stringify(body), /D1_ERROR|secret_customer_table|no such table/);
  } finally {
    globalThis.__LEAK1_DB__ = originalDb;
    console.error = originalError;
  }
});
