import { expect, test } from "@playwright/test";

/*
 * Precondition for every journey below: the development-preview superuser must be OFF.
 *
 * lib/development-preview.ts grants superuser ["*"] on localhost/127.0.0.1. scripts/e2e/serve.sh
 * declares PAWSPACE_DEPLOYMENT_ENV, which is that module's first gate, so preview refuses outright.
 * If this test fails, every journey after it is meaningless - they would all pass as a superuser.
 */
test("preview superuser is disabled: privileged APIs refuse an unauthenticated caller", async ({ request }, testInfo) => {
  // Authentication is a server/API invariant, not a browser-device behavior. Certify it once in the
  // desktop project instead of issuing the same server probes again from the mobile project. The
  // real customer RBAC tests below still execute in every configured browser project.
  test.skip(testInfo.project.name !== "chromium", "server auth precondition is project-independent");

  for (const path of ["/api/crm", "/api/pricing-control"]) {
    const res = await request.get(path, { headers: { "user-agent": "PawSpace-E2E-Auth-Precondition/1.0" } });
    expect(res.status(), `${path} must not be readable without authentication`).toBeGreaterThanOrEqual(401);
    expect(res.status(), `${path} must not be readable without authentication`).toBeLessThan(500);
  }
});

/*
 * Real RBAC, not the preview grant: this actor exists in app_users with role_code 'customer'.
 *
 * CORRECTED after a first run. /api/pricing-control was originally in this list and returned 200 -
 * which is CORRECT, not a hole: its GET authorizes on "pricing.view", a permission the customer role
 * legitimately holds, and it returns the package catalogue a customer needs in order to book. The
 * boundary that matters there is the WRITE, which requires "pricing.manage". Asserting the read was
 * my mistake, and asserting it would have pinned a false defect.
 */
test("a seeded customer identity cannot reach staff-only surfaces", async ({ request }) => {
  const asCustomer = { "oai-authenticated-user-email": "e2e.customer@pawspace.test" };
  for (const path of ["/api/crm", "/api/customer-360?customerId=E2E-CUS-UI-001"]) {
    const res = await request.get(path, { headers: asCustomer });
    expect(res.status(), `a customer must be refused ${path}`).toBeGreaterThanOrEqual(401);
    expect(res.status(), `a customer must be refused ${path}`).toBeLessThan(500);
  }
});

test("a customer can READ the pricing catalogue but cannot WRITE pricing", async ({ request }) => {
  const asCustomer = { "oai-authenticated-user-email": "e2e.customer@pawspace.test" };
  const read = await request.get("/api/pricing-control", { headers: asCustomer });
  expect(read.status(), "a customer needs the catalogue to book").toBe(200);

  const write = await request.post("/api/pricing-control", {
    headers: { ...asCustomer, "content-type": "application/json" },
    data: { action: "save_package", packageCode: "e2e-hack", basePrice: 1 },
  });
  expect(write.status(), "a customer must never write pricing").toBeGreaterThanOrEqual(400);
  expect(write.status(), "pricing write refusal must be governed, not a crash").toBeLessThan(500);
});

// No route fixtures: this executes the built worker, actual auth, runtime controls, schema setup,
// response headers and HTTP dispatch. The seeded record has NO trusted gateway capture evidence.
test("V2 built worker: OTP session reads its catalogue and canonical recovery without fake success", async ({ page, request }) => {
  await page.goto("/v2", { waitUntil: "domcontentloaded" });
  const login = await page.evaluate(async () => {
    const post = (body: object) => fetch("/api/customer-otp", { method: "POST", credentials: "include",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const challengeResponse = await post({ action: "request", phone: "9800000111" });
    const challenge = await challengeResponse.json();
    if (!challengeResponse.ok || !/^[0-9]{6}$/.test(challenge.data?.sandboxCode || "") || challenge.data?.liveSmsDelivered === true) {
      throw new Error(`Local sandbox challenge failed: ${challengeResponse.status}`);
    }
    const verified = await post({ action: "verify", challengeId: challenge.data.challengeId,
      code: challenge.data.sandboxCode, name: "E2E UI Customer" });
    const value = await verified.json();
    return { status: verified.status, customerId: value.data?.customerId };
  });
  expect(login).toEqual({ status: 200, customerId: "E2E-CUS-UI-001" });
  const reads = await page.evaluate(async () => {
    const result = [];
    for (const path of ["/api/v2/grooming-catalogue", "/api/v2/grooming-checkout?bookingId=E2E-BK-UI-001",
      "/api/v2/grooming-checkout?bookingId=OTHER-CUSTOMER-BOOKING", "/api/v2/admin"]) {
      const response = await fetch(path, { credentials: "include", cache: "no-store" });
      result.push({ path, status: response.status, cache: response.headers.get("cache-control"),
        typeOptions: response.headers.get("x-content-type-options"), body: await response.json() });
    }
    return result;
  });
  expect(reads.map(item => item.status)).toEqual([200, 200, 404, 403]);
  for (const read of reads) { expect(read.cache).toBe("no-store"); expect(read.typeOptions).toBe("nosniff"); }
  expect(Array.isArray(reads[0].body.data.packages)).toBe(true);
  expect(reads[1].body.data.customerId).toBe("E2E-CUS-UI-001");
  expect(reads[1].body.data.confirmation.ready).toBe(false);
  expect(reads[1].body.data.confirmation.transactionId).toBeNull();
  await page.goto("/v2/grooming?bookingId=E2E-BK-UI-001", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("E2E-BK-UI-001", { exact: true })).toBeVisible();
  await expect(page.getByText("Your grooming visit is confirmed", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /do not pay again/i })).toBeDisabled();
  const anonymous = await request.get("/api/v2/grooming-catalogue");
  expect(anonymous.status()).toBe(401);
});

test("V2 built worker: cross-site oversized callbacks retain bounded redirects and strict receipt headers", async ({ request }) => {
  const base = new URL(process.env.E2E_BASE_URL || "http://127.0.0.1:8788");
  expect(["127.0.0.1", "localhost"]).toContain(base.hostname);
  for (const body of ["razorpay_signature=forged", "padding=" + "x".repeat(17000)]) {
    const response = await request.post("/api/v2/grooming-checkout-return?bookingId=E2E-BK-UI-001&next=https://evil.test", {
      headers: { origin: "https://api.razorpay.com", "content-type": "application/x-www-form-urlencoded" },
      data: body, maxRedirects: 0, timeout: 5000,
    });
    expect(response.status()).toBe(303);
    const target = new URL(response.headers().location);
    expect(target.origin).toBe(base.origin); expect(target.pathname).toBe("/v2/grooming");
    expect([...target.searchParams.keys()]).toEqual(["bookingId"]);
    expect(response.headers()["cache-control"]).toBe("no-store");
    expect(response.headers()["referrer-policy"]).toBe("no-referrer");
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  }
});
