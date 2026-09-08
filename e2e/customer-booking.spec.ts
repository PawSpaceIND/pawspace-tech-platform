import { expect, test } from "@playwright/test";

const phone = process.env.PW_CUSTOMER_PHONE || "9000000911";

async function sandboxLogin(page: import("@playwright/test").Page, loginPhone=phone) {
  await page.goto("/mobile-app");
  const account = page.locator("nav").getByRole("button", { name: /account/i }).last();
  await account.click();
  await page.getByPlaceholder("10-digit phone number").fill(loginPhone);
  await page.getByRole("button", { name: "Send OTP" }).click();
  const sandbox = page.getByText(/Sandbox code \(no real SMS yet\):/i);
  await expect(sandbox).toBeVisible();
  const code = (await sandbox.textContent())?.match(/\b(\d{6})\b/)?.[1];
  expect(code, "local sandbox OTP must be rendered").toMatch(/^\d{6}$/);
  await page.getByPlaceholder("6-digit code").fill(code!);
  const name = page.getByPlaceholder("Your name (first time only)");
  if (await name.isVisible().catch(() => false)) await name.fill("Browser E2E Customer");
  const verify = page.waitForResponse(response => response.url().includes("/api/customer-otp") && response.request().method() === "POST" && response.ok());
  await page.getByRole("button", { name: "Verify & continue" }).click();
  await verify;
  await expect(page.getByPlaceholder("6-digit code")).toBeHidden();
}

async function ensureCustomerPet(page: import("@playwright/test").Page) {
  const accountResponse = await page.context().request.get("/api/customer-account");
  expect(accountResponse.ok(), `customer account must resolve after sandbox OTP (${accountResponse.status()})`).toBeTruthy();
  const account = await accountResponse.json().catch(() => ({})) as { data?: { pets?: Array<{ name?: string }> } };
  if (account.data?.pets?.length) return;

  const create = await page.context().request.post("/api/customer-account", {
    data: {
      action: "upsert_pet",
      idempotencyKey: `browser-e2e:customer-pet:${phone}`,
      pet: {
        name: "Buddy",
        species: "dog",
        breed: "Labrador Retriever",
        vaccinationStatus: "not_provided",
      },
    },
  });
  if (!create.ok()) throw new Error(`authenticated customer pet seed failed (${create.status()}): ${await create.text()}`);

  await expect.poll(async () => {
    const response = await page.context().request.get("/api/customer-account");
    if (!response.ok()) return false;
    const body = await response.json().catch(() => ({})) as { data?: { pets?: Array<{ name?: string }> } };
    return Boolean(body.data?.pets?.some(pet => pet.name === "Buddy"));
  }).toBe(true);
}

function serviceCard(page: import("@playwright/test").Page, name: string) {
  return page.getByRole("region", { name: "Care services" }).getByRole("article").filter({ hasText: name }).first();
}

test("customer: sandbox sign-in -> grooming checkout -> persisted booking", async ({ page }) => {
  await sandboxLogin(page);
  await ensureCustomerPet(page);
  await page.goto("/mobile-app");

  const home = page.locator("nav").getByRole("button", { name: /home/i }).last();
  await home.click();
  await expect(page.getByText("Everything they need", { exact: true })).toBeVisible();

  const grooming = serviceCard(page, "Grooming");
  const training = serviceCard(page, "Training");
  const boarding = serviceCard(page, "Boarding");
  await expect(grooming).toBeVisible();
  await expect(training).toBeVisible();
  await expect(boarding).toBeVisible();
  await expect(grooming.getByRole("button", { name: /book now/i })).toBeVisible();
  await expect(training.getByRole("button", { name: /book now/i })).toBeVisible();
  await expect(boarding.getByRole("button", { name: /book now/i })).toBeVisible();

  const location = page.getByRole("button", { name: "Choose your service location" });
  if (await location.isVisible().catch(() => false)) {
    await location.click();
    await page.getByPlaceholder("e.g. HSR Layout, Bengaluru").fill("Indiranagar, Bengaluru");
    await page.getByRole("button", { name: "Save location" }).click();
    await expect(page.getByRole("button", { name: /Choose your service location/i })).toContainText(/Indiranagar\s*,?\s*Bengaluru/i);
  }

  await grooming.getByRole("button", { name: /book now/i }).click();
  await expect(page.getByText("Who needs grooming?", { exact: false })).toBeVisible();
  await expect(page.getByText("Buddy", { exact: true }).first()).toBeVisible();

  const choosePackage = page.getByRole("button", { name: /Choose a package/i });
  await expect(choosePackage).toBeEnabled();
  await choosePackage.click();
  await expect(page.getByText(/Essential Bath|Bath & Basic|Complete Makeover|Just Trim/i).first()).toBeVisible();

  await page.getByRole("button",{name:"Choose address and requested time",exact:true}).click();
  await page.getByLabel("Complete doorstep address",{exact:true}).fill("42, Indiranagar Double Road, Stage 2, Hoysala Nagar, Indiranagar, Bengaluru");
  await page.getByLabel("Pincode",{exact:true}).fill("560038");
  await page.getByRole("button",{name:"Verify map",exact:true}).click();
  await page.getByRole("region",{name:"Matching map addresses",exact:true}).getByRole("button",{name:/42.*Indiranagar Double Road/}).first().click();
  await expect(page.getByText("Verified service doorstep",{exact:true})).toBeVisible();

  // Separate project slots while exercising the dates actually offered by the customer UI.
  const ist=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date());
  const part=(type:string)=>Number(ist.find(value=>value.type===type)?.value);
  const target=new Date(part("year"),part("month")-1,part("day")+(test.info().project.name==="mobile-chromium"?3:2));
  const label=new Intl.DateTimeFormat("en-IN",{weekday:"short",day:"numeric",month:"short"}).format(target);
  await page.getByRole("button",{name:label,exact:true}).click();
  await page.getByRole("button",{name:/^11:00 AM–1:00 PM/}).click();
  await page.getByRole("button",{name:"Review booking",exact:true}).click();
  await expect(page.getByText("Review and confirm",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:/^Pay after service/}).click();
  const created=page.waitForResponse(response=>response.url().includes("/api/canonical-bookings")&&response.request().method()==="POST");
  await page.getByRole("button",{name:"Confirm booking",exact:true}).click();
  const response=await created;
  expect(response.status(),await response.text()).toBe(201);
  const result=await response.json(),bookingId=String(result.data?.bookingId||"");
  expect(bookingId).not.toBe("");
  await expect(page.getByText("Your groomer is reserved.",{exact:true})).toBeVisible();
  await expect(page.getByText(`BOOKING CONFIRMED · ${bookingId}`,{exact:true})).toBeVisible();
  // Read the customer-owned account view; the all-bookings endpoint is correctly staff-only.
  const saved=await page.context().request.get("/api/customer-account");
  expect(saved.ok()).toBeTruthy();const savedBody=await saved.json();
  const rows=savedBody.data.bookings.filter((booking:{id:string})=>booking.id===bookingId);
  expect(rows).toHaveLength(1);expect(rows[0].serviceCode).toBe("grooming");expect(rows[0].status).toBe("confirmed");
  await page.getByRole("navigation",{name:"Customer navigation"}).getByRole("button",{name:/Activity/}).click();
  const activity=page.locator("article").filter({hasText:bookingId});
  await expect(activity).toHaveCount(1);
  await activity.getByRole("link",{name:"View booking and care →",exact:true}).click();
  await expect(page).toHaveURL(new RegExp(`/grooming/manage[?]bookingId=${bookingId}$`));
  await expect(page.getByRole("region",{name:"Booking details"})).toContainText(bookingId);
  await page.reload();
  await expect(page.getByRole("region",{name:"Booking details"})).toContainText(bookingId);
  await expect(page.getByRole("region",{name:"Booking details"})).toContainText("confirmed");
  await page.screenshot({path:test.info().outputPath("customer-grooming-persisted.png"),fullPage:true});
  await page.goto("/grooming/manage?bookingId=NOT-ON-THIS-CUSTOMER-ACCOUNT");
  await expect(page.getByRole("heading",{name:"Booking unavailable",exact:true})).toBeVisible();
  await expect(page.getByRole("region",{name:"Booking details"})).toHaveCount(0);
  await page.context().clearCookies();
  await page.goto(`/grooming/manage?bookingId=${encodeURIComponent(bookingId)}`);
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("region",{name:"Booking details"})).toHaveCount(0);
  await sandboxLogin(page,"9000000913");
  await page.goto(`/grooming/manage?bookingId=${encodeURIComponent(bookingId)}`);
  await expect(page.getByRole("heading",{name:"Booking unavailable",exact:true})).toBeVisible();
  await expect(page.getByRole("region",{name:"Booking details"})).toHaveCount(0);


});

test("customer can select next month when grooming opens on the last evening of this month",async({page})=>{
 await sandboxLogin(page);await ensureCustomerPet(page);
 await page.clock.setFixedTime(new Date("2026-09-30T18:00:00Z"));
 await page.goto("/mobile-app");
 await serviceCard(page,"Grooming").getByRole("button",{name:/book now/i}).click();
 await page.getByRole("button",{name:/Choose a package/i}).click();
 await page.getByRole("button",{name:"Choose address and requested time",exact:true}).click();
 const tomorrow=page.getByRole("button",{name:"Thu, 1 Oct",exact:true});
 await expect(tomorrow).toBeVisible();await tomorrow.click();await expect(tomorrow).toHaveAttribute("aria-pressed","true");
 const lastDate=page.getByRole("button",{name:"Fri, 30 Oct",exact:true});
 await lastDate.click();await expect(lastDate).toHaveAttribute("aria-pressed","true");
 await expect(tomorrow).toHaveAttribute("aria-pressed","false");
});


test("address choice: customer can recover from a wrong map match and editing clears verification",async({page})=>{
 await sandboxLogin(page);await ensureCustomerPet(page);
 await page.goto("/mobile-app");
 await serviceCard(page,"Grooming").getByRole("button",{name:/book now/i}).click();
 await page.getByRole("button",{name:/Choose a package/i}).click();
 await page.getByRole("button",{name:"Choose address and requested time",exact:true}).click();
 // Controlled external Maps responses exercise selection/recovery; this case does not certify Google.
 const resolved:string[]=[];
 await page.route("**/api/address-autocomplete?*",async route=>{
  const query=new URL(route.request().url()).searchParams;
  if(query.get("mode")==="search")return route.fulfill({json:{data:{status:"configured",suggestions:[
   {placeId:"area",mainText:"Indiranagar",secondaryText:"Bengaluru",fullText:"Indiranagar, Bengaluru"},
   {placeId:"doorstep",mainText:"42 Double Road",secondaryText:"Bengaluru 560038",fullText:"42 Double Road, Indiranagar, Bengaluru 560038"}
  ]}}});
  resolved.push(query.get("placeId")||"");
  await route.fulfill({json:{data:{status:"configured",address:query.get("placeId")==="doorstep"?"42 Double Road, Indiranagar, Bengaluru 560038":"Indiranagar, Bengaluru",latitude:12.978,longitude:77.641}}});
 });
 await page.getByLabel("Complete doorstep address",{exact:true}).fill("42 Double Road, Indiranagar, Bengaluru");
 await page.getByLabel("Pincode",{exact:true}).fill("560038");
 await page.getByRole("button",{name:"Verify map",exact:true}).click();
 const matches=page.getByRole("region",{name:"Matching map addresses",exact:true});
 await expect(matches.getByRole("button")).toHaveCount(2);
 expect(resolved).toEqual([]);
 await matches.getByRole("button",{name:"Indiranagar, Bengaluru",exact:true}).click();
 await expect(page.getByRole("alert")).toContainText("Choose another match");
 await expect(page.getByRole("button",{name:"Verify service address",exact:true})).toBeDisabled();
 await page.screenshot({path:test.info().outputPath("customer-address-choice.png"),fullPage:true});
 await matches.getByRole("button",{name:"42 Double Road, Indiranagar, Bengaluru 560038",exact:true}).click();
 await expect(page.getByText("Verified service doorstep",{exact:true})).toBeVisible();
 expect(resolved).toEqual(["area","doorstep"]);
 await expect(page.getByRole("button",{name:"Review booking",exact:true})).toBeEnabled();
 await page.getByLabel("Pincode",{exact:true}).fill("560034");
 await expect(page.getByText("Verified service doorstep",{exact:true})).toBeHidden();
 await expect(page.getByRole("button",{name:"Verify service address",exact:true})).toBeDisabled();
 await expect.poll(()=>page.evaluate(()=>sessionStorage.getItem("pawspace.selected-service-address"))).toBeNull();
});
