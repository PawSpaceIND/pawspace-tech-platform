import { test, expect } from "@playwright/test";

/*
 * Every vertical's CUSTOMER SCREEN, in a real browser.
 *
 * The rest of this suite proves one vertical end to end - 04-multi-actor drives grooming - and
 * scripts/e2e/vertical-journeys.mjs proves the APIs carry all ten. Neither proves the SCREENS do, and
 * a screen is where this platform has failed before: /mobile-app rendered blank in the 2026-09-05
 * audit while its API was healthy the whole time. An API that answers 200 behind a page that renders
 * nothing is not a working vertical.
 *
 * Driven as the seeded customer identity, never the preview superuser, so what these assert is what a
 * real customer sees.
 */
const AS_CUSTOMER = { "oai-authenticated-user-email": "e2e.customer@pawspace.test" };
test.use({ extraHTTPHeaders: AS_CUSTOMER });

/** A screen that renders nothing, or renders a crash, is the failure this file exists to catch. */
const BROKEN = /Application error|Something went wrong|Unhandled Runtime Error|client-side exception/i;
/* "Unable to load X" is this codebase's own refusal wording. On a CUSTOMER screen it means the page
   is up but its data is not, which reads to the customer as a broken service. */
const REFUSED = /Unable to load|Permission denied|Failed to fetch/i;

/**
 * Eight of the nine non-grooming verticals, and the wording that proves each screen reached its own
 * content rather than a shell. Each pattern is specific to the service: a generic /book|price/ would
 * pass on a page that rendered only the site header.
 *
 * The ninth, vet_consult, has no customer screen to assert BECAUSE it has not launched; the service
 * picker test below is what covers it, by proving it is never offered.
 */
const VERTICALS = [
  { name: "boarding", path: "/boarding", content: /boarding|stay|host|night/i },
  { name: "pet sitting", path: "/sitting", content: /sitting|sitter|visit/i },
  { name: "dog walking", path: "/walking", content: /walk/i },
  { name: "training", path: "/training", content: /training|session|trainer|obedience/i },
  { name: "pet taxi", path: "/taxi", content: /taxi|ride|pickup|drop/i },
  { name: "food", path: "/food", content: /food|kg|meal|subscription/i },
  { name: "relocation", path: "/relocation", content: /relocation|relocate|move|transport/i },
  { name: "funeral & memorial", path: "/funeral-memorial", content: /funeral|memorial|farewell|cremation/i },
] as const;

for (const vertical of VERTICALS) {
  test(`${vertical.name}: the customer screen renders its own bookable surface`, async ({ page }) => {
    const response = await page.goto(vertical.path, { waitUntil: "domcontentloaded" });
    expect(response?.status(), `${vertical.path} must resolve`).toBe(200);

    // Poll rather than read once: these screens hydrate and then fetch their own catalogue.
    await expect.poll(async () => (await page.locator("body").innerText()).replace(/\s+/g, " ").trim().length,
      { message: `${vertical.path} must not render blank`, timeout: 20_000 }).toBeGreaterThan(200);

    const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    expect(body, `${vertical.path} must not render a crash`).not.toMatch(BROKEN);
    expect(body, `${vertical.path} must not show the customer a refusal`).not.toMatch(REFUSED);
    expect(body, `${vertical.path} must reach its own content, not just the site shell`).toMatch(vertical.content);
  });
}

test("the service picker offers every live vertical and nothing that cannot be booked", async ({ page, request }) => {
  /*
   * The catalogue and the screen have to agree. /api/service-availability is what decides what may be
   * offered; Doorstep Vet is in the catalogue and is NOT enabled, because no provider anywhere can
   * take a vet_consult booking. A picker that offers it sends the customer to a dead end phrased as a
   * temporary capacity problem, which is the defect the service-control launch state fixed.
   */
  const api = await request.get("/api/service-availability?cityId=blr&zoneId=blr-east");
  expect(api.ok(), `service availability must load (${api.status()})`).toBeTruthy();
  const services = (await api.json()).data as Array<{ code: string; name: string; enabled: boolean }>;

  const vet = services.find((service) => service.code === "vet_consult");
  expect(vet, "vet_consult stays in the catalogue - not launched is not the same as deleted").toBeTruthy();
  expect(vet!.enabled, "a service no provider can deliver must not be offered").toBe(false);

  const response = await page.goto("/services", { waitUntil: "domcontentloaded" });
  expect(response?.status()).toBe(200);
  await expect.poll(async () => (await page.locator("body").innerText()).trim().length,
    { message: "/services must not render blank", timeout: 20_000 }).toBeGreaterThan(200);
  const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  expect(body).not.toMatch(BROKEN);

  /*
   * The other direction, and the one the API answer alone cannot prove: a service the catalogue has
   * NOT launched must not be offered here either. Asserted on the links, not on the page text -
   * "Doorstep" appears in the grooming copy too, so a body-text search would both false-positive and
   * teach nothing. What matters is whether the picker hands the customer a way in.
   */
  const offers = await page.locator("a").evaluateAll((nodes) => nodes.map((node) => ({
    href: node.getAttribute("href") ?? "",
    text: (node.textContent ?? "").replace(/\s+/g, " ").trim(),
  })));
  const vetOffer = offers.find((offer) => /\/vet(\/|$)/.test(offer.href) || /^doorstep vet\b/i.test(offer.text));
  expect(vetOffer, `/services must not link a customer into a service that has not launched: ${JSON.stringify(vetOffer)}`)
    .toBeFalsy();

  /*
   * Every enabled service is named on the picker, so nothing live is unreachable from it - searched
   * in the page's own visible content, with the site chrome and the non-rendered nodes removed.
   * Both would make this assertion lie: the footer carries permanent links to five services, and the
   * JSON-LD block names eight more in a <script>. Either would report Grooming as "offered" with its
   * card deleted from the grid, which is the exact failure this assertion exists to catch.
   */
  const grid = await page.evaluate(() => {
    const clone = document.body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("header,footer,nav,script,style,noscript,template").forEach((element) => element.remove());
    return (clone.textContent ?? "").replace(/\s+/g, " ");
  });
  for (const service of services.filter((s) => s.enabled)) {
    const words = service.name.split(/[^A-Za-z]+/).filter((w) => w.length > 3);
    expect(words.length, `${service.code} has a nameable label`).toBeGreaterThan(0);
    expect(grid, `${service.name} is enabled and must be offered on /services`)
      .toMatch(new RegExp(words[0], "i"));
  }
});

test("no booking screen puts internal jargon on a label the customer reads as the product", async ({ page }) => {
  /*
   * A deliberately narrow rule, and narrower than this test first asserted. These ARE UAT flows, and
   * the prose that tells a customer live money is not connected, or that document storage is not
   * wired up yet, is honest disclosure worth keeping - stripping it would make the screens claim
   * more than the platform can do.
   *
   * So the rule splits on what the text IS, not on what it says. A LABEL - a heading, a button, a
   * link, a section eyebrow - names the product, and must be in the customer's language. A SENTENCE
   * discloses what the system does or does not do, and is left alone. "Short and not punctuated as a
   * sentence" separates the two cheaply and without a hand-maintained allowlist.
   *
   * Every one of these was live: /walking's primary call to action read "Create canonical UAT
   * schedule", /taxi's confirmation was headed "CANONICAL PET TAXI · INTERNAL UAT", and the screen
   * where a customer arranges their pet's funeral was labelled "FUNERAL & MEMORIAL · INTERNAL UAT".
   *
   * e2e/journeys/01-customer.spec.ts holds the separate, stricter rule for the DISCOVERY surfaces,
   * where no sandbox or prototype wording may appear at all.
   */
  const JARGON = /\b(UAT|sandbox|prototype|canonical|dummy|mock)\b/i;
  const findings: string[] = [];
  for (const vertical of VERTICALS) {
    await page.goto(vertical.path, { waitUntil: "domcontentloaded" });
    await expect.poll(async () => (await page.locator("body").innerText()).trim().length,
      { timeout: 20_000 }).toBeGreaterThan(200);

    const labels: string[] = await page.evaluate(() => {
      const out: string[] = [];
      for (const element of Array.from(document.body.querySelectorAll("*"))) {
        if (element.closest("script,style,noscript")) continue;
        const own = Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent ?? "")
          .join(" ").replace(/\s+/g, " ").trim();
        // Longer or sentence-punctuated text is prose: judged as disclosure, not as a label.
        if (!own || own.length > 60 || /[.!?]$/.test(own)) continue;
        out.push(`${element.tagName.toLowerCase()}: ${own}`);
      }
      return out;
    });

    for (const label of labels) {
      if (JARGON.test(label)) findings.push(`${vertical.path} ${label.slice(0, 80)}`);
    }
  }
  expect(findings, "a customer must not be shown our release vocabulary on a heading, button or label").toEqual([]);
});
