import { test, expect } from "@playwright/test";

/*
 * Precondition for every journey below: the development-preview superuser must be OFF.
 *
 * lib/development-preview.ts grants superuser ["*"] on localhost/127.0.0.1. scripts/e2e/serve.sh
 * declares PAWSPACE_DEPLOYMENT_ENV, which is that module's first gate, so preview refuses outright.
 * If this test fails, every journey after it is meaningless - they would all pass as a superuser.
 */
test("preview superuser is disabled: privileged APIs refuse an unauthenticated caller", async ({ request }) => {
  for (const path of ["/api/customer-360?customerId=E2E-CUS-UI-001", "/api/crm", "/api/pricing-control"]) {
    const res = await request.get(path);
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
