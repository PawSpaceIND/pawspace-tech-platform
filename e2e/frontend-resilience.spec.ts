import { expect, test } from "@playwright/test";

const API = "**/api/booking-command-center";

async function expectRecoveredEmptyState(page: import("@playwright/test").Page) {
  await expect(page.getByText("No canonical bookings yet", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeHidden();
}

async function bypassVinextDevOverlayPointerInterception(page: import("@playwright/test").Page) {
  await page.addStyleTag({
    content: `
      #__vinext_dev_error_overlay_root,
      #__vinext_dev_error_overlay_root * {
        pointer-events: none !important;
      }
    `,
  });
}

test("resilience: 429 rate limit surfaces fallback and explicit retry succeeds", async ({ page }) => {
  let attempts = 0;
  await page.route(API, async route => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "1" },
        body: JSON.stringify({ error: "Too many requests. Please try again shortly." }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ bookings: [] }) });
  });

  await page.goto("/booking-command-center");
  await expect(page.getByText(/Too many requests/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expectRecoveredEmptyState(page);
  expect(attempts, "retry must issue a second request after a 429").toBeGreaterThanOrEqual(2);
});

test("resilience: malformed HTML gateway response never blanks the page and retry recovers", async ({ page }) => {
  let attempts = 0;
  await page.route(API, async route => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({ status: 502, contentType: "text/html", body: "<html><body>bad gateway</body></html>" });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ bookings: [] }) });
  });

  await page.goto("/booking-command-center");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Booking Command Center" })).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expectRecoveredEmptyState(page);
  expect(attempts).toBeGreaterThanOrEqual(2);
});

test("resilience: timed-out/dropped API request shows recoverable state", async ({ page }) => {
  let attempts = 0;
  await page.route(API, async route => {
    attempts += 1;
    if (attempts === 1) {
      await route.abort("timedout");
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ bookings: [] }) });
  });

  await page.goto("/booking-command-center");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expectRecoveredEmptyState(page);
  expect(attempts).toBeGreaterThanOrEqual(2);
});

test("resilience: offline -> online switch preserves UI and retry restores data path", async ({ page, context }) => {
  await page.route(API, route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ bookings: [] }) }));
  await page.goto("/booking-command-center");
  await expectRecoveredEmptyState(page);
  await page.unroute(API);

  await context.setOffline(true);
  await page.getByRole("button", { name: /Refresh/i }).click();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Booking Command Center" })).toBeVisible();

  await context.setOffline(false);
  await page.route(API, route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ bookings: [] }) }));
  await page.getByRole("button", { name: "Try again" }).click();
  await expectRecoveredEmptyState(page);
});

test("resilience: render failure reaches route error boundary and reset recovers", async ({ page }) => {
  let attempts = 0;
  await page.route(API, async route => {
    attempts += 1;
    if (attempts === 1) {
      // Valid JSON but deliberately invalid domain shape: the component will attempt booking.id during
      // render, proving the React/Next route error boundary rather than only the fetch catch path.
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ bookings: [null] }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ bookings: [] }) });
  });

  await page.goto("/booking-command-center");
  await expect(page.getByRole("alert")).toContainText("This page didn't load");
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();

  // Vinext's development diagnostics intentionally overlay uncaught render failures. In E2E we still
  // exercise the real route error boundary and a real pointer click, but prevent the dev-only overlay
  // from intercepting that pointer interaction. This does not alter production/runtime error handling.
  await bypassVinextDevOverlayPointerInterception(page);
  await page.getByRole("button", { name: "Try again" }).click();

  await expectRecoveredEmptyState(page);
  expect(attempts).toBeGreaterThanOrEqual(2);
});
