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
  const account = await accountResponse.json().catch(() => ({})) as { data?: { customerId?: string; pets?: Array<{ name?: string }> } };
  if (account.data?.pets?.length) return;
  expect(account.data?.customerId).toBeTruthy();

  const create = await page.context().request.post("/api/customer-account", {
    data: {
      action: "upsert_pet",
      idempotencyKey: `browser-e2e:customer-pet:${account.data!.customerId}`,
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
    const body = await response.json().catch(() => ({})) as { data?: { customerId?: string; pets?: Array<{ name?: string }> } };
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
    const locationDialog = page.getByRole("dialog", { name: "Choose your service area" });
    await expect(locationDialog).toBeVisible();
    await locationDialog.getByRole("button", { name: "Browse without location", exact: true }).click();
    await expect(locationDialog).toBeHidden();
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
  // Exercise the authenticated reschedule transaction against the real local D1 worker.
  const newStart=new Date(new Date(rows[0].scheduledStart).getTime()+4*3600000).toISOString();
  const newEnd=new Date(new Date(rows[0].scheduledEnd).getTime()+4*3600000).toISOString();
  const terms=await page.context().request.get(`/api/grooming-booking-change?bookingId=${encodeURIComponent(bookingId)}`);expect(terms.status()).toBe(200);const termsBody=await terms.json();expect(termsBody.data.consentRevision).toMatch(/^[a-f0-9]{64}$/);
  const changed=await page.context().request.post("/api/grooming-booking-change",{data:{expectedConsentRevision:termsBody.data.consentRevision,bookingId,customerId:savedBody.data.customerId,action:"reschedule",reason:"Customer requested a later afternoon slot",scheduledStart:newStart,scheduledEnd:newEnd}});
  expect(changed.status(),await changed.text()).toBe(200);
  const refreshed=await page.context().request.get("/api/customer-account");
  expect(refreshed.ok()).toBeTruthy();const refreshedBody=await refreshed.json();
  const changedBooking=refreshedBody.data.bookings.find((booking:{id:string})=>booking.id===bookingId);
  expect(changedBooking.scheduledStart).toBe(newStart);expect(changedBooking.status).toBe("assigned");

  await page.locator("nav").getByRole("button",{name:/Activity/}).last().click();
  const activity=page.locator("article").filter({hasText:bookingId});
  await expect(activity).toHaveCount(1);
  await activity.getByRole("link",{name:"View booking and care →",exact:true}).click();
  await expect(page).toHaveURL(new RegExp(`/grooming/manage[?]bookingId=${bookingId}$`));
  await expect(page.getByRole("region",{name:"Booking details"})).toContainText(bookingId);
  await page.reload();
  await expect(page.getByRole("region",{name:"Booking details"})).toContainText(bookingId);
  await expect(page.getByRole("region",{name:"Booking details"})).toContainText("assigned");
  const policy=page.getByRole("region",{name:"Booking change policy",exact:true});
  await expect(policy.getByRole("heading",{name:"Rescheduling available",exact:true})).toBeVisible();
  await expect(policy.getByRole("heading",{name:"Cancellation eligible",exact:true})).toBeVisible();
  await expect(policy).toContainText("Estimated refund: ₹0.00");
  await page.screenshot({path:test.info().outputPath("customer-grooming-persisted.png"),fullPage:true});
  const rescheduleForm=page.getByRole("form",{name:"Reschedule booking",exact:true});
  await expect(rescheduleForm.getByRole("button",{name:"Confirm new appointment",exact:true})).toBeDisabled();
  await rescheduleForm.getByLabel("New appointment date",{exact:true}).fill(newStart.slice(0,10));await rescheduleForm.getByLabel("New appointment time (IST)",{exact:true}).fill("11:00");await rescheduleForm.getByLabel("Reason for changing the appointment",{exact:true}).fill("Please move our appointment back to late morning.");await rescheduleForm.getByRole("checkbox").check();
  const movedResponse=page.waitForResponse(response=>response.url().endsWith("/api/grooming-booking-change")&&response.request().method()==="POST");await rescheduleForm.getByRole("button",{name:"Confirm new appointment",exact:true}).click();const moved=await movedResponse;expect(moved.status()).toBe(200);const movedBody=await moved.json();expect(movedBody.data.rescheduleFeeAmount).toBe(0);expect(movedBody.data.scheduledStart).toBe(new Date(`${newStart.slice(0,10)}T11:00:00+05:30`).toISOString());expect(Date.parse(movedBody.data.scheduledEnd)-Date.parse(movedBody.data.scheduledStart)).toBe(120*60000);
  await expect(page.getByRole("status").filter({hasText:"Booking rescheduled"})).toBeVisible();await page.reload();await expect(page.getByRole("region",{name:"Booking details",exact:true})).toContainText("11:00");
  const cancelForm=page.getByRole("form",{name:"Cancel or review booking",exact:true});
  const confirm=cancelForm.getByRole("button",{name:"Confirm cancellation",exact:true});
  await expect(confirm).toBeDisabled();await cancelForm.getByLabel("Reason for your request",{exact:true}).fill("Our plans changed; please cancel this appointment.");await expect(confirm).toBeDisabled();await cancelForm.getByRole("checkbox").check();
  // Controlled review response verifies that a recorded case is not presented as an unrecorded failure.
  await page.route("**/api/grooming-booking-change",route=>route.fulfill({status:409,contentType:"application/json",body:JSON.stringify({code:"cancellation_requires_approval",caseId:"UI-REVIEW-CASE",bookingStatusUnchanged:"assigned",refundPromised:false})}),{times:1});
  await confirm.click();await expect(page.getByRole("status").filter({hasText:"Case reference: UI-REVIEW-CASE"})).toBeVisible();await expect(page.getByRole("status").filter({hasText:"Case reference: UI-REVIEW-CASE"})).toContainText("no refund is promised");await expect(page.getByRole("region",{name:"Booking details",exact:true})).toContainText("assigned");
  await cancelForm.getByLabel("Reason for your request",{exact:true}).fill("Our plans changed; please cancel this appointment.");await cancelForm.getByRole("checkbox").check();
  // Controlled conflict verifies UI recovery; the retry below reaches the real authenticated worker.
  await page.route("**/api/grooming-booking-change",async route=>{if(route.request().method()==="POST")await route.fulfill({status:409,contentType:"application/json",body:JSON.stringify({error:"Booking change terms have changed. Review the latest preview before confirming.",code:"booking_change_terms_changed"})});else await route.continue();},{times:1});
  await confirm.click();await expect(cancelForm.getByRole("alert")).toContainText("terms have changed");await expect(cancelForm.getByRole("checkbox")).not.toBeChecked();await expect(confirm).toHaveCount(0);
  await cancelForm.getByRole("button",{name:"Refresh terms before retrying",exact:true}).click();
  await cancelForm.getByLabel("Reason for your request",{exact:true}).fill("Our plans changed; please cancel this appointment.");await cancelForm.getByRole("checkbox").check();
  const cancellation=page.waitForResponse(response=>response.url().endsWith("/api/grooming-booking-change")&&response.request().method()==="POST");await confirm.click();const cancelled=await cancellation;expect(cancelled.status()).toBe(200);const cancelledBody=await cancelled.json();expect(cancelledBody.data.status).toBe("cancelled");expect(cancelledBody.data.refundAmount).toBe(0);
  await expect(page.getByRole("region",{name:"Booking details",exact:true})).toContainText("cancelled");await expect(page.getByRole("status").filter({hasText:"Booking cancelled"})).toBeVisible();await expect(cancelForm).toHaveCount(0);
  await page.reload();await expect(page.getByRole("region",{name:"Booking details",exact:true})).toContainText("cancelled");await expect(page.getByRole("heading",{name:"Cancellation unavailable",exact:true})).toBeVisible();await page.screenshot({path:test.info().outputPath("customer-grooming-cancelled.png"),fullPage:true});
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

for(const mode of ["boarding","sitting"] as const)test(`${mode}: customer-selected afternoon and evening times reach the real quote`,async({page,browser})=>{
 await sandboxLogin(page,mode==="boarding"?"9000000943":"9000000944");await ensureCustomerPet(page);await page.goto(`/${mode}`);
 await expect(page.getByText("Buddy",{exact:true}).first()).toBeVisible();
 await page.getByRole("button",{name:/^4 hours/}).click();
 const offset=5+(test.info().project.name==="mobile-chromium"?2:0)+test.info().retry;const date=new Date(Date.now()+offset*86400000).toISOString().slice(0,10);await page.getByLabel("Start",{exact:true}).fill(date);
 await page.getByLabel("Complete doorstep address",{exact:true}).fill("42, Indiranagar Double Road, Stage 2, Hoysala Nagar, Indiranagar, Bengaluru");await page.getByLabel("Pincode",{exact:true}).fill("560038");await page.getByRole("button",{name:"Verify map",exact:true}).click();await page.getByRole("region",{name:"Matching map addresses",exact:true}).getByRole("button",{name:/42.*Indiranagar Double Road/}).first().click();await expect(page.getByText("Verified service doorstep",{exact:true})).toBeVisible();
 for(const[time,utc]of [["13:00","07:30"],["18:00","12:30"]]){
  const expectedStart=`${date}T${utc}:00.000Z`;
  const quoted=page.waitForResponse(response=>response.url().endsWith(`/api/${mode}-commercial`)&&response.request().method()==="POST"&&response.request().postDataJSON()?.scheduledStart===expectedStart);
  await page.getByRole("combobox",{name:"Start time",exact:true}).selectOption(time);
  const response=await quoted;expect(response.status(),await response.text()).toBe(201);const body=await response.json();expect(new Date(body.data.scheduledStart).toISOString()).toBe(expectedStart);expect(new Date(body.data.scheduledEnd).getTime()-new Date(body.data.scheduledStart).getTime()).toBe(4*3600000);
 }
 await page.getByRole("button",{name:`See available ${mode==="boarding"?"homes":"sitters"}`,exact:true}).click();
 await expect(page.getByRole("heading",{name:`Choose your ${mode==="boarding"?"host":"sitter"}`,exact:true})).toBeVisible();
 if(mode==="sitting"){
  await expect(page.getByRole("alert")).toContainText("No sitter is available for this care window");
  await expect(page.getByRole("button",{name:"Choose an available caregiver",exact:true})).toBeDisabled();
  await page.getByRole("button",{name:/Trip details/}).click();
  const available=page.waitForResponse(response=>response.url().endsWith("/api/uat-scheduling")&&response.request().method()==="POST"&&response.request().postDataJSON()?.scheduledStart===`${date}T07:30:00.000Z`);
  await page.getByRole("combobox",{name:"Start time",exact:true}).selectOption("13:00");
  const availability=await available;expect(availability.status()).toBe(200);const candidates=await availability.json();expect(candidates.data.providers.length).toBeGreaterThan(0);
  await page.getByRole("button",{name:"See available sitters",exact:true}).click();
 }
 await page.getByRole("button",{name:/^Continue with /}).click();
 await page.getByLabel("Vet contact",{exact:true}).fill("UAT vet contact: 9000000951");
 await page.getByLabel("Emergency contact",{exact:true}).fill("UAT emergency contact: 9000000952");
 if(mode==="sitting")await page.getByLabel("Home access instructions",{exact:true}).fill("UAT fixture: call the customer at the gate.");
 await page.getByRole("button",{name:"Review protected booking",exact:true}).click();
 const review=page.getByRole("article",{name:"Review stay details",exact:true});await expect(review).toContainText(mode==="sitting"?"13:00 IST":"18:00 IST");await expect(review).toContainText("4 hours");
 if(mode==="sitting"){await expect(review).not.toContainText("Overnight Pet Sitting");await expect(review).not.toContainText("Accepted offer");}
 const consent=page.getByRole("checkbox",{name:/I agree to care/});await expect(consent).not.toBeChecked();
 await expect(page.getByRole("button",{name:/^Pay .* (create canonical stay|request final partner approval)$/})).toBeDisabled();
 await page.screenshot({path:test.info().outputPath(`customer-${mode}-review.png`),fullPage:true});
 await consent.check();
 const pay=page.getByRole("button",{name:/^Pay .* (create canonical stay|request final partner approval)$/});
 if(mode==="boarding"){
  const before=await page.context().request.get("/api/customer-account");expect(before.ok()).toBeTruthy();const initial=await before.json();
  const writes:string[]=[];page.on("request",request=>{if(request.method()==="POST"&&/\/api\/(uat-scheduling|canonical-bookings|boarding-bookings|boarding-payment)/.test(request.url()))writes.push(request.url());});
  await pay.click();await expect(page.getByRole("alert")).toContainText("Boarding requires verified vaccination");
  expect(writes).toHaveLength(0);const after=await page.context().request.get("/api/customer-account");expect(after.ok()).toBeTruthy();expect((await after.json()).data.bookings).toEqual(initial.data.bookings);
 }else{
  const created=page.waitForResponse(response=>response.url().endsWith("/api/sitting-bookings")&&response.request().method()==="POST");await pay.click();const response=await created;expect(response.status(),await response.text()).toBe(201);const body=await response.json();const bookingId=String(body.data.bookingId);expect(bookingId).not.toBe("");
  await expect(page.getByRole("heading",{name:"Your sitting booking",exact:true})).toBeVisible();
  await expect(page.getByText(bookingId,{exact:true})).toBeVisible();
  const saved=await page.context().request.get("/api/customer-account");expect(saved.ok()).toBeTruthy();const account=await saved.json();const rows=account.data.bookings.filter((booking:{id:string})=>booking.id===bookingId);expect(rows).toHaveLength(1);expect(rows[0].serviceCode).toBe("pet_sitting");expect(new Date(rows[0].scheduledStart).toISOString()).toBe(`${date}T07:30:00.000Z`);
  await page.goto(`/sitting/manage?bookingId=${encodeURIComponent(bookingId)}`);await expect(page.getByRole("heading",{name:"Your sitting booking",exact:true})).toBeVisible();await expect(page.getByRole("textbox",{name:"Vet contact",exact:true})).toHaveValue("UAT vet contact: 9000000951");
  await expect(page.getByRole("region",{name:"Your sitting booking",exact:true})).toContainText(/1:00:00 pm IST/i);
  await page.screenshot({path:test.info().outputPath("customer-sitting-booked.png"),fullPage:true});
  const providerId=String(response.request().postDataJSON().provider.id),phones:Record<string,string>={sit_sana:"9000000945",sit_neha:"9000000946",sit_asha:"9000000947"};expect(phones[providerId]).toBeTruthy();
  const partner=await browser.newPage({baseURL:new URL(page.url()).origin,viewport:page.viewportSize()!});
  try{
   await partner.goto("/partner/onboarding");await partner.getByPlaceholder("10-digit phone number").fill(phones[providerId]);await partner.getByRole("button",{name:"Send OTP",exact:true}).click();
   const sandbox=partner.getByText(/Sandbox code \(no real SMS yet\):/i);await expect(sandbox).toBeVisible();const code=(await sandbox.textContent())?.match(/\b(\d{6})\b/)?.[1];expect(code).toMatch(/^\d{6}$/);await partner.getByPlaceholder("6-digit code").fill(code!);await partner.getByRole("button",{name:"Verify & continue",exact:true}).click();
   await expect.poll(()=>partner.evaluate(async()=>{const response=await fetch("/api/identity-session",{cache:"no-store"});if(!response.ok)return null;return(await response.json()).data?.subjectId;})).toBe(providerId);
   await partner.goto(`/sitter?bookingId=${encodeURIComponent(bookingId)}`);
   const accepted=partner.waitForResponse(response=>response.url().endsWith("/api/sitting-lifecycle")&&response.request().method()==="POST");await partner.getByRole("button",{name:"Accept booking",exact:true}).click();expect((await accepted).status()).toBe(200);
   await expect(partner.locator("main")).toContainText(/Status:\s*assigned/);await partner.reload();await expect(partner.locator("main")).toContainText(/Status:\s*assigned/);
   await page.reload();await expect(page.getByRole("region",{name:"Your sitting booking",exact:true})).toContainText("assigned");
   const sitterCare=partner.getByRole("region",{name:"Customer care instructions",exact:true});
   await expect(sitterCare).toContainText("UAT vet contact: 9000000951");await expect(sitterCare).toContainText("UAT emergency contact: 9000000952");await expect(sitterCare).toContainText("UAT fixture: call the customer at the gate.");
   await page.getByRole("textbox",{name:"Food and water routine",exact:true}).fill("Use the labelled food container. Refresh water after the meal.");await page.getByRole("button",{name:"Save care instructions",exact:true}).click();await expect(page.getByRole("status")).toContainText("Care instructions saved.");
   await partner.getByRole("button",{name:"Refresh booking",exact:true}).click();await expect(sitterCare).toContainText("Use the labelled food container. Refresh water after the meal.");
   await expect(partner.locator("main")).toContainText("1:00 pm IST");
   await partner.screenshot({path:test.info().outputPath("sitting-partner-accepted.png"),fullPage:true});
   await partner.evaluate(()=>Object.defineProperty(navigator,"geolocation",{configurable:true,value:{getCurrentPosition(_success:unknown,failure:(error:{code:number})=>void){failure({code:1});}}}));
   let checkInRequests=0;partner.on("request",request=>{if(request.method()==="POST"&&request.url().endsWith("/api/sitting-lifecycle")&&request.postDataJSON()?.action==="check_in")checkInRequests++;});
   await partner.getByRole("button",{name:"Check in with my location",exact:true}).click();await expect(partner.getByRole("alert")).toContainText("Allow location access");expect(checkInRequests).toBe(0);await expect(partner.locator("main")).toContainText(/Status:\s*assigned/);
   const unavailable=partner.getByRole("button",{name:"Mark unavailable",exact:true});await expect(unavailable).toBeDisabled();
   const reason="My vehicle broke down before travel; please arrange another sitter.";await partner.getByRole("textbox",{name:"Reason you are unavailable",exact:true}).fill(reason);
   const recovered=partner.waitForResponse(response=>response.url().endsWith("/api/sitting-lifecycle")&&response.request().method()==="POST"&&response.request().postDataJSON()?.action==="sitter_unavailable");await unavailable.click();const recoveryResponse=await recovered;expect(recoveryResponse.status()).toBe(202);expect(recoveryResponse.request().postDataJSON().reason).toBe(reason);
   await expect(partner.getByRole("status")).toContainText("Operations recovery requested");await expect(unavailable).toHaveCount(0);
   const persisted=await partner.evaluate(async id=>{const response=await fetch(`/api/sitting-lifecycle?bookingId=${encodeURIComponent(id)}`,{cache:"no-store"});if(!response.ok)throw new Error("Unable to read recovery");return(await response.json()).data[0];},bookingId);expect(persisted.id).toBe(bookingId);expect(persisted.status).toBe("reassignment_needed");expect(JSON.parse(persisted.recovery.detail_json).reason).toBe(reason);
   await page.reload();await expect(page.getByRole("region",{name:"Your sitting booking",exact:true})).toContainText("reassignment needed");await expect(page.getByRole("textbox",{name:"Food and water routine",exact:true})).toHaveValue("Use the labelled food container. Refresh water after the meal.");
   await partner.screenshot({path:test.info().outputPath("sitting-partner-recovery.png"),fullPage:true});
   // Use the real seeded UAT staff login; the persona lane keeps anonymous preview authority disabled.
   const ops=await browser.newPage({baseURL:new URL(page.url()).origin});try{const staffCode=process.env.PW_STAFF_UAT_ACCESS_CODE;expect(staffCode,"Disposable staff UAT code must be provisioned for this run").toBeTruthy();await ops.goto("/staging-login");await ops.getByPlaceholder("shared UAT access code").fill(staffCode!);const staffSignedIn=ops.waitForResponse(response=>response.url().endsWith("/api/staging-login")&&response.request().method()==="POST");await ops.getByRole("button",{name:"Manager (people & performance) jyoti.manager39@tkpetcare.in",exact:true}).click();expect((await staffSignedIn).status()).toBe(200);await ops.waitForURL("**/me");await expect.poll(()=>ops.evaluate(async()=>{const response=await fetch("/api/staging-login",{cache:"no-store"});return response.ok?(await response.json()).signedInAs?.email:null;})).toBe("jyoti.manager39@tkpetcare.in");await ops.goto("/team/operations/sitting");await ops.getByRole("button",{name:new RegExp(bookingId)}).click();const recoveryCard=ops.getByRole("article").filter({has:ops.getByRole("heading",{name:"Sitter recovery",exact:true})});await expect(recoveryCard).toContainText(reason);await expect(recoveryCard.getByRole("textbox",{name:"Operations replacement reason",exact:true})).toBeVisible();await ops.screenshot({path:test.info().outputPath("sitting-operations-recovery.png"),fullPage:true});
    await recoveryCard.getByRole("textbox",{name:"Operations replacement reason",exact:true}).fill("Original sitter cannot travel; offer this available sitter for the same care window.");
    const offered=ops.waitForResponse(response=>response.url().endsWith("/api/sitting-ops")&&response.request().method()==="POST"&&response.request().postDataJSON()?.action==="assign_replacement");await recoveryCard.getByRole("button",{name:"Offer replacement",exact:true}).first().click();const offerResponse=await offered;expect(offerResponse.status(),await offerResponse.text()).toBe(202);const replacementId=String(offerResponse.request().postDataJSON().providerId);expect(replacementId).not.toBe(providerId);expect(phones[replacementId]).toBeTruthy();
    const replacement=await browser.newPage({baseURL:new URL(page.url()).origin,viewport:page.viewportSize()!});try{
     await replacement.goto("/partner/onboarding");await replacement.getByPlaceholder("10-digit phone number").fill(phones[replacementId]);await replacement.getByRole("button",{name:"Send OTP",exact:true}).click();const replacementOtp=replacement.getByText(/Sandbox code \(no real SMS yet\):/i);await expect(replacementOtp).toBeVisible();const replacementCode=(await replacementOtp.textContent())?.match(/\b(\d{6})\b/)?.[1];expect(replacementCode).toMatch(/^\d{6}$/);await replacement.getByPlaceholder("6-digit code").fill(replacementCode!);await replacement.getByRole("button",{name:"Verify & continue",exact:true}).click();
     await expect.poll(()=>replacement.evaluate(async()=>{const response=await fetch("/api/identity-session",{cache:"no-store"});return response.ok?(await response.json()).data?.subjectId:null;})).toBe(replacementId);
     await replacement.goto(`/sitter?bookingId=${encodeURIComponent(bookingId)}`);await expect(replacement.getByRole("region",{name:"Customer care instructions",exact:true})).toContainText("Use the labelled food container.");
     const replacementAccepted=replacement.waitForResponse(response=>response.url().endsWith("/api/sitting-lifecycle")&&response.request().method()==="POST"&&response.request().postDataJSON()?.action==="accept");await replacement.getByRole("button",{name:"Accept replacement booking",exact:true}).click();expect((await replacementAccepted).status()).toBe(200);await expect(replacement.locator("main")).toContainText(/Status:\s*assigned/);
     await ops.getByRole("button",{name:/Refresh/}).click();await ops.getByRole("button",{name:new RegExp(bookingId)}).click();const closed=ops.waitForResponse(response=>response.url().endsWith("/api/sitting-ops")&&response.request().method()==="POST"&&response.request().postDataJSON()?.action==="close_recovery");await ops.getByRole("button",{name:"Close accepted recovery",exact:true}).click();expect((await closed).status()).toBe(200);
     await page.reload();await expect(page.getByRole("region",{name:"Your sitting booking",exact:true})).toContainText("assigned");const accountAfter=await page.context().request.get("/api/customer-account");expect(accountAfter.ok()).toBeTruthy();const preserved=(await accountAfter.json()).data.bookings.filter((row:{id:string})=>row.id===bookingId);expect(preserved).toHaveLength(1);expect(preserved[0].providerId).toBe(replacementId);expect(new Date(preserved[0].scheduledStart).toISOString()).toBe(`${date}T07:30:00.000Z`);
     await replacement.screenshot({path:test.info().outputPath("sitting-replacement-accepted.png"),fullPage:true});
    }finally{await replacement.close();}
}finally{await ops.close();}



  }finally{await partner.close();}

 }

});
