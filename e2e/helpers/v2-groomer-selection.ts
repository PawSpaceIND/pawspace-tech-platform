import { expect, type Page } from "@playwright/test";

/** Shared by the hosted journey and rendered-page regressions. Does not reserve or pay. */
export async function chooseFirstNamedGroomer(page: Page): Promise<string> {
  const section = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Available for this exact slot", exact: true }),
  });
  await expect(section).toHaveCount(1);
  const automatic = section.getByRole("button", {
    name: "PawSpace chooses the best available groomer", exact: true,
  });
  await expect(automatic).toBeVisible();
  // Named cards have a visible name; the leading automatic-matching control does not.
  const card = section.getByRole("button").filter({ has: page.locator("b") }).first();
  await expect(card).toBeEnabled();
  const name = (await card.locator("b").innerText()).replace(/\s+/g, " ").trim();
  expect(name, "a named groomer, not the automatic-matching control").not.toBe("");
  await card.click();
  await expect(card).toHaveAttribute("aria-pressed", "true");
  await expect(card).toContainText("✓");
  await expect(automatic).toHaveAttribute("aria-pressed", "false");
  const summary = page.locator("aside").filter({ hasText: /your care plan/i });
  const groomerRow = summary.locator("div").filter({ has: page.getByText("Groomer", { exact: true }) }).last();
  await expect(groomerRow.locator("b")).toHaveText(name);
  return name;
}
