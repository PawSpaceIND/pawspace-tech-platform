import { expect, test } from "@playwright/test";

test("CX live updates and reconnect preserve the operator's search", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "oai-authenticated-user-email": "e2e.admin@pawspace.test" });
  await page.addInitScript(() => {
    class DemoEventSource extends EventTarget {
      onerror: (() => void) | null = null;
      constructor(_url: string) { super(); (window as unknown as { cxStream: DemoEventSource }).cxStream = this; }
      close() {}
    }
    Object.defineProperty(window, "EventSource", { value: DemoEventSource });
  });
  await page.goto("/team/customer-experience", { waitUntil: "domcontentloaded" });
  const search = page.getByPlaceholder("Search leads or conversations...");
  await expect(search).toBeVisible();
  await search.fill("Bruno follow-up in progress");
  for (const event of ["conversation", "ready", "conversation"]) {
    await page.evaluate((name) => {
      (window as unknown as { cxStream: EventTarget }).cxStream.dispatchEvent(new MessageEvent(name, { data: JSON.stringify({ version: 123 }) }));
    }, event);
    await expect(search).toHaveValue("Bruno follow-up in progress");
  }
});
