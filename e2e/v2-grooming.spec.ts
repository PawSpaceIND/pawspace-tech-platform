import { test, expect, type Page } from "@playwright/test";

type Fixture = {
  bookingCount?: number; offersUnavailable?: boolean;
  bookingWrites: number; orderWrites: number; locationWrites: number; locationFailures: number;
  providers?: Array<{ id: string; name: string; model: string; rating: number }>;
  couponGate?: Promise<void>; couponStarted: boolean; couponValid?: boolean; couponDiscount?: number; couponFinalOverride?: number; couponInputs: Array<{code:string;orderValue:number}>;
  captured: boolean; confirmed: boolean; locationReady: boolean; unauthorized: boolean; quoteSource: string;
  previewGate?: Promise<void>; coverageGate?: Promise<void>; previewStarted: boolean; coverageStarted: boolean;
  booking: Record<string, unknown> | null; reservation: Record<string, unknown> | null;
};
async function fixture(page: Page) {
  const state: Fixture = { bookingWrites: 0, orderWrites: 0, locationWrites: 0, locationFailures: 0,
    captured: false, confirmed: false, locationReady: false, unauthorized: false, quoteSource: "pricing_control",
    previewStarted: false, coverageStarted: false, couponStarted: false, couponInputs: [], booking: null, reservation: null };
  const provider = { id: "PRV1", name: "Arjun - PawSpace Care", model: "full_time", rating: 4.9 };
  const bundle = { petCount: 1, packageCode: "dog-basic", price: 1899, currency: "INR", slotMinutes: 120,
    blockingMinutes: 150, effectiveFrom: "2020-01-01", effectiveTo: null };
  await page.addInitScript(() => {
    // Explicit SDK transport double. No request goes to a real payment provider.
    (window as unknown as { Razorpay: unknown }).Razorpay = class {
      options: Record<string, unknown>;
      constructor(options: Record<string, unknown>) { this.options = options; }
      on() {} close() {}
      open() {
        const handler = this.options.handler as (result: Record<string, string>) => void;
        queueMicrotask(() => handler({ razorpay_order_id: "order_v2_fixture", razorpay_payment_id: "pay_v2_fixture", razorpay_signature: "a".repeat(64) }));
      }
    };
  });
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const body = request.method() === "POST" ? request.postDataJSON() as Record<string, unknown> : {};
    const reply = (data: unknown, status = 200) => route.fulfill({ status, json: { data } });
    if (path === "/api/identity-session") return reply({ subjectType: "customer", subjectId: "C1" });
    if (path === "/api/service-availability") return reply([{ code: "grooming", enabled: true }]);
    if (path === "/api/customer-account") return reply({ customerId: "C1", name: "Meera", primaryPhone: "9000000901", addresses: [], bookings: [],
      pets: [{ id: "PET-1", sourceId: "PET-1", name: "Bruno", species: "dog", breed: "Golden Retriever", ageYears: 3, vaccinationStatus: "verified" }] });
    if (path === "/api/v2/grooming-catalogue") return reply({ serviceCode: "grooming", packages: [{ code: "dog-basic", name: "Bath & Basic",
      description: "A gentle bath, coat care and finishing touches for your best friend.", audience: "dog", bundles: [bundle] }] });
    if (path === "/api/service-zone") {
      state.coverageStarted = true; if (state.coverageGate) await state.coverageGate;
      return reply({ assignment: { cityId: "blr", city: "Bengaluru", zoneId: "blr-east", pincode: url.searchParams.get("pincode"), area: "Indiranagar" },
        zone: { zoneId: "blr-east", zoneName: "Bengaluru East", serviceAvailable: true } });
    }
    if (path === "/api/live-price-quote") return reply({ price: 1899, source: state.quoteSource });
    if (path === "/api/uat-scheduling") {
      if (body.action === "preview") {
        state.previewStarted = true; if (state.previewGate) await state.previewGate;
        expect(body.serviceAddress).toContain("Indiranagar"); expect(body.servicePincode).toBe("560038");
        return reply({ providers: state.providers || [provider], availabilityChecked: true, reserved: false, cityId: body.cityId, zoneId: body.zoneId,
          scheduledStart: body.scheduledStart, scheduledEnd: body.scheduledEnd });
      }
      state.reservation = body; return reply({ groupId: body.clientRequestId, provider });
    }
    if (path === "/api/customer-offers") {
      if(state.offersUnavailable)return route.fulfill({status:503,json:{error:"Available offers are temporarily unavailable"}});
      const count=state.bookingCount||0;
      return reply({normalCouponsAllowed:count<3,bookingCount:count,coupons:count<3?[{code:"NORMAL",name:"Normal grooming offer",discountType:"fixed",discountValue:200,maxDiscount:200,minOrder:500,description:"₹200 off on orders above ₹500",autoApply:false,savings:200,finalAmount:Number(url.searchParams.get("orderValue"))-200}]:[],message:count>=3?"Normal offers are available for your first three bookings. Use a special code issued to your account.":undefined});
    }
    if (path === "/api/coupon-governance") {
      const input = body.input as { code: string; orderValue: number }, valid = state.couponValid !== false && !(input.code==="NORMAL" && (state.bookingCount||0)>=3);
      state.couponStarted = true; state.couponInputs.push(input);
      if (state.couponGate) await state.couponGate;
      const discount = state.couponDiscount ?? 200;
      return reply(valid ? { valid: true, code: input.code, discount, quoteId: `CPQ-${input.code}`, finalAmount: state.couponFinalOverride ?? (Math.round(input.orderValue * 100) - Math.round(discount * 100)) / 100 }
        : { valid: false, discount: 0, error: "The previous coupon is no longer available" });
    }
    if (path === "/api/canonical-bookings") {
      state.bookingWrites++; state.booking = body;
      return reply({ bookingId: "B1", customerId: "C1", petIds: ["PET-1"], scheduleGroupId: body.scheduleGroupId,
        workOrderId: "WO1", paymentId: "P1", status: "payment_pending", duplicatePrevented: false });
    }
    if (path === "/api/grooming-service-location") {
      state.locationWrites++;
      if (state.locationFailures-- > 0) return route.fulfill({ status: 503, json: { error: "Address verification temporarily unavailable" } });
      state.locationReady = true; return reply({ bookingId: "B1", addressSaved: true, coordinatesSaved: true });
    }
    if (path === "/api/v2/grooming-checkout") {
      if (state.unauthorized) return route.fulfill({ status: 401, json: { error: "Sign in to the customer account that made this booking." } });
      return reply({ bookingId: "B1", customerId: "C1", locationReady: state.locationReady,
        bookingStatus: state.confirmed ? "confirmed" : "payment_pending", paymentStatus: state.captured ? "captured" : "created",
        confirmation: { ready: state.confirmed, bookingId: "B1", serviceCode: "grooming", packageName: "Bath & Basic",
          bookingStatus: state.confirmed ? "confirmed" : "payment_pending", paymentId: "P1", paymentMode: "prepaid", paymentStatus: state.captured ? "captured" : "created",
          transactionId: state.captured ? "pay_v2_fixture" : null, amountDueNow: state.captured ? 0 : 1899, totalAmount: 1899, currency: "INR",
          providerId: provider.id, providerName: provider.name, providerModel: provider.model,
          workOrderStatus: state.confirmed ? "assigned" : "payment_pending", scheduledStart: state.booking?.scheduledStart,
          scheduledEnd: state.booking?.scheduledEnd, updatedAt: 1, pets: [{ id: "PET-1", name: "Bruno", species: "dog", breed: "Golden Retriever" }] } });
    }
    if (path === "/api/customer-checkout") {
      if (body.action === "start") {
        state.orderWrites++;
        return reply({ connected: true, status: "awaiting_payment", environment: "sandbox", bookingId: "B1", orderId: "order_v2_fixture",
          // Deliberately short synthetic ID; this API response and the SDK are both test doubles.
          keyId: "rzp_test_v2", amountPaise: 189900, currency: "INR",
          locks: { PAWSPACE_PAYMENT_ENV: "sandbox", FORBID_PRODUCTION: "true", PAWSPACE_PAYMENT_LIVE_APPROVED: "false" } });
      }
      if (body.action === "confirm") {
        state.captured = true;
        // Real contract: capture can be verified before the complete confirmation projection exists.
        return reply({ bookingId: "B1", orderId: "order_v2_fixture", receiptVerified: true, environment: "sandbox", status: "captured" });
      }
      return reply({ bookingId: "B1", environment: "sandbox", status: state.captured ? "captured" : "awaiting_confirmation" });
    }
    return route.fulfill({ status: 404, json: { error: "Outside the isolated V2 browser contract fixture" } });
  });
  return state;
}
async function openCare(page: Page) {
  await page.goto("/v2/grooming");
  await expect(page.getByRole("heading", { name: /A calmer spa day/ })).toBeVisible();
  await page.getByLabel("House, street & area").fill("21 Indiranagar Main Road");
  await page.getByLabel("PIN code", { exact: true }).fill("560038");
}
async function previewCare(page: Page) {
  await openCare(page);
  await page.getByRole("button", { name: "Check service area" }).click();
  await expect(page.getByText("Bengaluru East is covered")).toBeVisible();
  await page.getByRole("button", { name: /Check live price & groomers/ }).click();
  await expect(page.getByRole("heading", { name: "Available for this exact slot" })).toBeVisible();
}

test("V2 contract: care -> single booking -> verified capture -> canonical confirmation -> reload", async ({ page }) => {
  const state = await fixture(page), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await previewCare(page);
  await expect(page.getByRole("link", { name: "Close grooming booking" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("v2-grooming-care.png"), fullPage: true });
  await page.getByRole("button", { name: /Reserve & review payment/ }).evaluate(element => {
    (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click();
  });
  await expect(page).toHaveURL(/bookingId=B1/);
  await expect(page.getByRole("button", { name: "Pay securely with Razorpay" })).toBeEnabled();
  expect(state.bookingWrites).toBe(1); expect(state.locationWrites).toBe(1); expect(state.orderWrites).toBe(0);
  await page.getByRole("button", { name: "Pay securely with Razorpay" }).click();
  await expect(page.getByRole("heading", { name: "Payment verified. Finalizing your visit." })).toBeVisible();
  await expect(page.getByText("Your grooming visit is confirmed", { exact: true })).toBeHidden();
  expect(state.orderWrites).toBe(1);
  state.confirmed = true;
  await page.getByRole("button", { name: "Check verified status" }).click();
  await expect(page.getByText("Your grooming visit is confirmed", { exact: true })).toBeVisible();
  await expect(page.getByText("pay_v2_fixture", { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("v2-grooming-confirmed.png"), fullPage: true });
  await page.reload();
  await expect(page.getByText("Your grooming visit is confirmed", { exact: true })).toBeVisible();
  expect(state.bookingWrites).toBe(1); expect(state.orderWrites).toBe(1); expect(errors).toEqual([]);
});

test("V2 contract: stale coverage cannot verify an edited doorstep", async ({ page }) => {
  const state = await fixture(page);
  let release!: () => void;
  state.coverageGate = new Promise(resolve => { release = resolve; });
  await openCare(page);
  await page.getByRole("button", { name: "Check service area" }).click();
  await expect.poll(() => state.coverageStarted).toBe(true);
  await page.getByLabel("PIN code", { exact: true }).fill("560001");
  const settled = page.waitForResponse(response => response.url().includes("/api/service-zone") && response.ok());
  release(); await settled;
  await expect(page.getByText("Bengaluru East is covered")).toBeHidden();
  await expect(page.getByRole("button", { name: /Check live price & groomers/ })).toBeDisabled();
  expect(state.bookingWrites).toBe(0);
});

test("V2 contract: delayed provider results cannot restore a stale quote after editing", async ({ page }) => {
  const state = await fixture(page);
  let release!: () => void;
  state.previewGate = new Promise(resolve => { release = resolve; });
  await openCare(page); await page.getByRole("button", { name: "Check service area" }).click();
  await expect(page.getByText("Bengaluru East is covered")).toBeVisible();
  await page.getByRole("button", { name: /Check live price & groomers/ }).click();
  await expect.poll(() => state.previewStarted).toBe(true);
  await page.getByLabel("House, street & area").fill("42 Indiranagar Different Road");
  const settled = page.waitForResponse(response => response.url().includes("/api/uat-scheduling") && response.ok());
  release(); await settled;
  await expect(page.getByRole("heading", { name: "Available for this exact slot" })).toBeHidden();
  await expect(page.getByRole("button", { name: /Reserve & review payment/ })).toBeDisabled();
  expect(state.bookingWrites).toBe(0);
});

test("V2 contract: address failure preserves booking and blocks payment until recovery", async ({ page }) => {
  const state = await fixture(page); state.locationFailures = 1;
  await previewCare(page); await page.getByRole("button", { name: /Reserve & review payment/ }).click();
  await expect(page).toHaveURL(/bookingId=B1/);
  await expect(page.getByRole("heading", { name: "Verify the doorstep for this booking" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pay securely with Razorpay" })).toBeDisabled();
  await page.getByRole("button", { name: "Save verified doorstep" }).click();
  await expect(page.getByRole("button", { name: "Pay securely with Razorpay" })).toBeEnabled();
  expect(state.bookingWrites).toBe(1); expect(state.locationWrites).toBe(2); expect(state.orderWrites).toBe(0);
});

test("V2 contract: fallback pricing never enables reservation", async ({ page }) => {
  const state = await fixture(page); state.quoteSource = "fallback_default";
  await openCare(page); await page.getByRole("button", { name: "Check service area" }).click();
  await expect(page.getByText("Bengaluru East is covered")).toBeVisible();
  await page.getByRole("button", { name: /Check live price & groomers/ }).click();
  await expect(page.getByText(/published live grooming price could not be verified/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Reserve & review payment/ })).toBeDisabled();
  expect(state.bookingWrites).toBe(0);
});

test("V2 contract: unauthorized recovery cannot open a payment", async ({ page }) => {
  const state = await fixture(page); state.unauthorized = true;
  await page.goto("/v2/grooming?bookingId=B1");
  await expect(page.getByRole("alert")).toContainText("Sign in to the customer account");
  await expect(page.getByRole("button", { name: "Pay securely with Razorpay" })).toBeDisabled();
  expect(state.bookingWrites).toBe(0); expect(state.orderWrites).toBe(0);
});


test("V2 contract: full-page payment return verifies the receipt, scrubs URL and never creates a new order", async ({ page }) => {
  const state = await fixture(page);
  state.locationReady = true;
  const date = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  state.booking = { scheduledStart: `${date}T05:30:00.000Z`, scheduledEnd: `${date}T07:30:00.000Z` };
  const confirmation = page.waitForRequest(request => request.url().endsWith("/api/customer-checkout") &&
    request.method() === "POST" && request.postDataJSON().action === "confirm");
  const signature = "a".repeat(64);
  await page.goto(`/v2/grooming?bookingId=B1&payment=returned&orderId=order_v2_fixture&paymentId=pay_v2_fixture&signature=${signature}`);
  const receipt = (await confirmation).postDataJSON();
  expect(receipt).toMatchObject({ bookingId: "B1", orderId: "order_v2_fixture", paymentId: "pay_v2_fixture", signature });
  await expect(page).toHaveURL(/\/v2\/grooming\?bookingId=B1$/);
  await expect(page.getByRole("heading", { name: "Payment verified. Finalizing your visit." })).toBeVisible();
  expect(state.bookingWrites).toBe(0); expect(state.orderWrites).toBe(0);
  await expect(page.getByRole("button", { name: /do not pay again/ })).toBeDisabled();
  state.confirmed = true;
  await page.getByRole("button", { name: "Check verified status" }).click();
  await expect(page.getByText("Your grooming visit is confirmed", { exact: true })).toBeVisible();
  expect(state.bookingWrites).toBe(0); expect(state.orderWrites).toBe(0);
});

test('explicit V2 rejects a contradictory city/PIN before availability or booking', async ({page}) => {
  const state = await fixture(page); await openCare(page);
  await page.getByLabel('House, street & area').fill('24 Audit Road, Mumbai, Maharashtra');
  await page.getByRole('button',{name:'Check service area'}).click();
  await expect(page.getByRole('alert')).toContainText('different city');
  await expect(page.getByRole('button',{name:/Check live price & groomers/})).toBeDisabled();
  expect(state.previewStarted).toBe(false); expect(state.bookingWrites).toBe(0);
});
async function familyFixture(page:Page, pets:Array<{id:string;name:string;species:string;ageYears:number}>) {
  const state = await fixture(page);
  await page.route('**/api/customer-account',route=>route.fulfill({json:{data:{
    customerId:'C1',name:'QA Family',primaryPhone:'9000000901',addresses:[],bookings:[],pets,
  }}}));
  await page.goto('/v2/grooming');
  await expect(page.getByRole('heading',{name:/A calmer spa day/})).toBeVisible();
  return state;
}
test('explicit V2 separates puppy and kitten even though both are young pets',async({page})=>{
  const state=await familyFixture(page,[{id:'P1',name:'QA Puppy',species:'dog',ageYears:0.3},{id:'P2',name:'QA Kitten',species:'cat',ageYears:0.3}]);
  await page.getByRole('button',{name:/QA Kitten/}).click();
  await expect(page.getByRole('alert')).toContainText('cannot be mixed');
  await expect(page.getByRole('button',{name:/Reserve & review payment/})).toBeDisabled();
  expect(state.bookingWrites).toBe(0);expect(state.orderWrites).toBe(0);
});

test('explicit V2 fifth-pet enquiry preserves four pets and never grants consent',async({page})=>{
  const pets=Array.from({length:5},(_,i)=>({id:`P${i+1}`,name:`QA Dog ${i+1}`,species:'dog',ageYears:3}));
  const state=await familyFixture(page,pets);
  for(const pet of pets.slice(1))await page.getByRole('button',{name:new RegExp(pet.name)}).click();
  const enquiry=page.getByRole('dialog',{name:'Large pet family enquiry'});
  await expect(enquiry).toBeVisible();
  await expect(enquiry.locator('select[name="service"]')).toHaveValue('Grooming');
  for(const pet of pets)await expect(enquiry.locator('textarea[name="message"]')).toHaveValue(new RegExp(pet.name));
  await expect(enquiry.locator('input[name="whatsappConsent"]')).not.toBeChecked();
  await enquiry.getByRole('button',{name:'Return to booking'}).click();
  await expect(enquiry).toHaveCount(0);
  for(const pet of pets.slice(0,4))await expect(page.getByRole('button',{name:new RegExp(pet.name)})).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('button',{name:/QA Dog 5/})).toHaveAttribute('aria-pressed','false');
  expect(state.bookingWrites).toBe(0);expect(state.orderWrites).toBe(0);
});
test('explicit V2 review retains full address and distinguishes service area from geocoding',async({page})=>{
  await fixture(page);await previewCare(page);
  await expect(page.locator('aside').filter({ hasText: 'YOUR CARE PLAN' })).toContainText('21 Indiranagar Main Road, 560038');
  await expect(page.getByText('Service area matched only. The complete doorstep must still be map-verified before payment.')).toBeVisible();
});


test("G10: four visible keyboard-accessible steps preserve the complete booking draft", async ({ page }) => {
  const state = await fixture(page), requests: string[] = [];
  page.on("request", request => { if (request.url().includes("/api/")) requests.push(request.url()); });
  await openCare(page);
  const navigation = page.getByRole("navigation", { name: "Booking steps" });
  await expect(navigation.getByRole("button")).toHaveCount(4);
  for (const button of await navigation.getByRole("button").all()) await expect(button).toBeVisible();
  await expect(navigation.getByRole("button", { name: "4 Time & review" })).toBeDisabled();
  await page.getByRole("button", { name: "Check service area" }).click();
  await expect(page.getByText("Bengaluru East is covered")).toBeVisible();
  await page.getByRole("button", { name: /Check live price & groomers/ }).click();
  await expect(page.getByRole("heading", { name: "Available for this exact slot" })).toBeVisible();
  await page.getByLabel("Notes for your groomer (optional)").fill("Please be gentle with paws");
  const before = [...requests];
  await navigation.getByRole("button", { name: "1 Pets", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#v2-grooming-pets")).toBeFocused();
  await navigation.getByRole("button", { name: "4 Time & review" }).focus();
  await page.keyboard.press("Space");
  await expect(page.locator("#v2-grooming-time")).toBeFocused();
  await expect(page.getByLabel("House, street & area")).toHaveValue("21 Indiranagar Main Road");
  await expect(page.getByLabel("PIN code", { exact: true })).toHaveValue("560038");
  await expect(page.getByLabel("Notes for your groomer (optional)")).toHaveValue("Please be gentle with paws");
  await expect(page.getByRole("button", { name: /Reserve & review payment/ })).toBeEnabled();
  expect(requests).toEqual(before);
  expect(state.bookingWrites).toBe(0); expect(state.orderWrites).toBe(0); expect(state.reservation).toBeNull();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const bounds = await page.locator("[aria-label='Booking steps'], #v2-grooming-pets, #v2-grooming-package, #v2-grooming-address, #v2-grooming-time").evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect();
    return { id: element.id || element.getAttribute("aria-label"), x: rect.x, right: rect.right, width: rect.width, viewport: innerWidth };
  }));
  console.log("G10 visible content boundaries", JSON.stringify(bounds));
  for (const box of bounds) {
    expect(box.x, `${box.id} must not be clipped on the left`).toBeGreaterThanOrEqual(0);
    expect(box.right, `${box.id} must not be clipped on the right`).toBeLessThanOrEqual(box.viewport + 1);
  }
  await page.screenshot({ path: test.info().outputPath("g10-four-step-navigation.png"), fullPage: true });
  await page.getByLabel("House, street & area").fill("22 Indiranagar Main Road");
  await expect(navigation.getByRole("button", { name: "4 Time & review" })).toBeDisabled();
  await expect(page.getByRole("button", { name: /Reserve & review payment/ })).toBeDisabled();
});

test("G03: several eligible groomers no longer require manual selection, but customers can change it", async ({ page }) => {
  const state = await fixture(page);
  state.providers = [{ id: "ranked-first", name: "First Ranked Groomer", model: "commission", rating: 4.7 },
    { id: "ranked-second", name: "Second Ranked Groomer", model: "full_time", rating: 4.9 }];
  await previewCare(page);
  const first = page.getByRole("button", { name: /First Ranked Groomer/ });
  const second = page.getByRole("button", { name: /Second Ranked Groomer/ });
  await expect(first).toContainText("✓"); await expect(second).toContainText("Choose");
  await expect(page.getByRole("button", { name: /Reserve & review payment/ })).toBeEnabled();
  await second.click(); await expect(second).toContainText("✓"); await expect(first).toContainText("Choose");
  expect(state.bookingWrites).toBe(0); expect(state.reservation).toBeNull();
});

for (const oldValid of [true, false]) test(`G08: late ${oldValid ? "success" : "refusal"} from an old basket cannot replace a fresh coupon`, async ({ page }) => {
  const state = await fixture(page);
  let release!: () => void;
  state.couponGate = new Promise(resolve => { release = resolve; }); state.couponValid = oldValid;
  await previewCare(page);
  const couponBox = page.getByRole("group", { name: "Coupon code", exact: true });
  await couponBox.getByText("Have a special code?", {exact:true}).click();
  await couponBox.getByRole("textbox").fill("OLD200");
  await couponBox.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => state.couponStarted).toBe(true);
  await page.locator("#v2-grooming-time").getByRole("button").nth(2).click();
  await expect(couponBox).toHaveCount(0);
  state.couponGate = undefined; state.couponValid = true;
  await page.getByRole("button", { name: /Check live price & groomers/ }).click();
  await expect(couponBox).toBeVisible();
  await couponBox.getByText("Have a special code?", {exact:true}).click();
  await couponBox.getByRole("textbox").fill("NEW200");
  await couponBox.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByText(/Coupon NEW200/)).toBeVisible();
  const oldResponse = page.waitForResponse(response => response.url().includes("/api/coupon-governance") && response.request().postData()?.includes("OLD200") === true);
  release(); await oldResponse;
  // Let the fetch completion and both React paint turns settle before checking the parent's state.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.getByText(/Coupon NEW200/)).toBeVisible();
  await expect(page.getByText(/Coupon OLD200/)).toHaveCount(0);
  await expect(couponBox.getByRole("textbox")).toHaveValue("NEW200");
  await expect(page.getByRole("button", { name: /Reserve & review payment/ })).toBeEnabled();
  expect(state.bookingWrites).toBe(0); expect(state.orderWrites).toBe(0);
});


test("G08: V2 review preserves paise in the discount and payable total", async ({ page }) => {
  const state = await fixture(page); state.couponDiscount = 189.90;
  await previewCare(page);
  const box = page.getByRole("group", { name: "Coupon code", exact: true });
  await box.getByText("Have a special code?", {exact:true}).click();
  await box.getByRole("textbox").fill("PRECISE10");
  await box.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByText(/Coupon PRECISE10/)).toHaveText("Coupon PRECISE10 · −₹189.9");
  await expect(page.getByText("₹1,709.1", { exact: true })).toBeVisible();
  await expect(page.getByText("₹1,709", { exact: true })).toHaveCount(0);
  expect(state.bookingWrites).toBe(0); expect(state.orderWrites).toBe(0);
});

test("G08: V2 coupon preview and booking refresh use the same basket including extras", async ({page}) => {
  const state = await fixture(page); state.couponDiscount = 239.8;
  await openCare(page);
  await page.getByRole("checkbox", {name:/Tick & flea treatment/}).check();
  await page.getByRole("button", {name:"Check service area"}).click();
  await expect(page.getByText("Bengaluru East is covered")).toBeVisible();
  await page.getByRole("button", {name:/Check live price & groomers/}).click();
  const box=page.getByRole("group", {name:"Coupon code", exact:true});
  await box.getByText("Have a special code?", {exact:true}).click();
  await box.getByRole("textbox").fill("EXTRAS10");
  await box.getByRole("button", {name:"Apply",exact:true}).click();
  await expect(page.getByText("₹2,158.2",{exact:true})).toBeVisible();
  expect(state.couponInputs.map(input=>input.orderValue)).toEqual([2398]);
  await page.getByRole("button",{name:/Reserve & review payment/}).click();
  await expect(page).toHaveURL(/bookingId=B1/);
  expect(state.couponInputs.map(input=>input.orderValue)).toEqual([2398,2398]);
  expect(state.booking?.totalAmount).toBe(2158.2); expect(state.booking?.amountDueNow).toBe(2158.2);
  expect(state.bookingWrites).toBe(1); expect(state.orderWrites).toBe(0);
});

for (const bad of [{discount:100.001,final:1798.999},{discount:100,final:1700}]) test(`G08: malformed coupon money never appears applied: ${bad.discount}/${bad.final}`,async({page})=>{
  const state=await fixture(page); state.couponDiscount=bad.discount; state.couponFinalOverride=bad.final;
  await previewCare(page);
  const box=page.getByRole("group",{name:"Coupon code",exact:true});
  await box.getByText("Have a special code?", {exact:true}).click();
  await box.getByRole("textbox").fill("MALFORMED");
  await box.getByRole("button",{name:"Apply",exact:true}).click();
  await expect(box.getByRole("alert")).toHaveText("Reapply the coupon before booking.");
  await expect(page.getByText(/Coupon MALFORMED/)).toHaveCount(0);
  expect(state.bookingWrites).toBe(0); expect(state.reservation).toBeNull();
});


test("G11: an eligible offer applies without typing and can be removed",async({page})=>{
  const state=await fixture(page);await previewCare(page);
  const box=page.getByRole("group",{name:"Coupon code",exact:true});
  await expect(box.getByRole("heading",{name:"Available offers"})).toBeVisible();
  const size=await box.getByRole("region",{name:"Available offers"}).boundingBox();
  expect(size?.width).toBeGreaterThan(180);
  expect(size?.height).toBeLessThan(500);

  await expect(box.getByRole("textbox")).toBeHidden();
  await box.getByRole("button",{name:"Apply NORMAL",exact:true}).click();
  await expect(page.getByText(/Coupon NORMAL/)).toBeVisible();
  expect(state.couponInputs.at(-1)?.code).toBe("NORMAL");
  await box.getByRole("button",{name:"Remove coupon"}).click();
  await expect(page.getByText(/Coupon NORMAL/)).toHaveCount(0);
  expect(state.bookingWrites).toBe(0);expect(state.orderWrites).toBe(0);
  await page.screenshot({path:test.info().outputPath("g11-available-offers.png"),fullPage:true});
});
test("G12/G14: fourth booking hides normal offers but retains separate special-code entry",async({page})=>{
  const state=await fixture(page);state.bookingCount=3;await previewCare(page);
  const box=page.getByRole("group",{name:"Coupon code",exact:true});
  await expect(box.getByText(/first three bookings/)).toBeVisible();
  await expect(box.getByRole("button",{name:"Apply NORMAL"})).toHaveCount(0);
  await box.getByText("Have a special code?",{exact:true}).click();
  await box.getByRole("textbox").fill("PRIVATE");await box.getByRole("button",{name:"Apply",exact:true}).click();
  await expect(page.getByText(/Coupon PRIVATE/)).toBeVisible();
  expect(state.bookingWrites).toBe(0);expect(state.orderWrites).toBe(0);
});
test("G11: an offer withdrawn after browsing cannot become an applied coupon",async({page})=>{
  const state=await fixture(page);await previewCare(page);
  const box=page.getByRole("group",{name:"Coupon code",exact:true});
  await expect(box.getByRole("button",{name:"Apply NORMAL"})).toBeVisible();state.couponValid=false;
  await box.getByRole("button",{name:"Apply NORMAL"}).click();
  await expect(box.getByRole("alert")).toContainText("no longer available");
  await expect(page.getByRole("button",{name:/Reserve & review payment/})).toBeDisabled();
  await box.getByRole("button",{name:"Remove coupon"}).click();
  await expect(page.getByRole("button",{name:/Reserve & review payment/})).toBeEnabled();
  await expect(page.getByText(/Coupon NORMAL/)).toHaveCount(0);
  expect(state.bookingWrites).toBe(0);expect(state.orderWrites).toBe(0);
});
test("G11: offer lookup failure stays honest and supports retry without applying anything",async({page})=>{
  const state=await fixture(page);state.offersUnavailable=true;await previewCare(page);
  const box=page.getByRole("group",{name:"Coupon code",exact:true});
  await expect(box.getByText(/temporarily unavailable/)).toBeVisible();
  await expect(box.getByRole("button",{name:"Apply NORMAL"})).toHaveCount(0);state.offersUnavailable=false;
  await box.getByRole("button",{name:"Retry offers"}).click();await expect(box.getByRole("button",{name:"Apply NORMAL"})).toBeVisible();
  expect(state.couponStarted).toBe(false);expect(state.bookingWrites).toBe(0);
});
