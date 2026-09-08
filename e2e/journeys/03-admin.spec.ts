import { test, expect } from "@playwright/test";

/*
 * Employee / admin journey: workspace visibility -> control surfaces -> refund adjudication.
 * Driven as the seeded admin identity (app_users role_code='admin').
 */
const AS_ADMIN = { "oai-authenticated-user-email": "e2e.admin@pawspace.test" };
test.use({ extraHTTPHeaders: AS_ADMIN });

test("the team workspace renders for an admin", async ({ page }) => {
  const res = await page.goto("/team", { waitUntil: "domcontentloaded" });
  expect(res?.status()).toBe(200);
  await page.waitForTimeout(900);
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(/Application error|Unhandled Runtime Error/i);
  expect(body.replace(/\s+/g, " ").trim().length).toBeGreaterThan(150);
});

test("the control workspace renders and exposes governed sections", async ({ page }) => {
  const res = await page.goto("/control", { waitUntil: "domcontentloaded" });
  expect(res?.status()).toBe(200);
  await page.waitForTimeout(900);
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(/Application error|Unhandled Runtime Error/i);
  expect(body).toMatch(/control|audit|finance|operations/i);
});

test("an admin CAN adjudicate a cancellation case - the staff gate is not blanket-deny", async ({ request }) => {
  /* Non-vacuity for the provider refusal in 02-partner. "return 403 always" would satisfy that test
   * and break the product; staff must get past the same gate. The case id does not exist, so the
   * route refuses for a DIFFERENT reason - the only thing asserted is that it is not the staff 403. */
  const res = await request.get("/api/booking-cancellation-case?caseId=E2E-CASE-1");
  expect(await res.text()).not.toMatch(/cancellation_case_staff_only/);
});

test("refund adjudication surface is reachable and refuses malformed input safely", async ({ request }) => {
  const res = await request.post("/api/booking-cancellation-case", {
    headers: { "content-type": "application/json" },
    data: { caseId: "", action: "finance_decision" },
  });
  // Must be a governed 4xx, never a 500 leaking internals.
  expect(res.status(), "malformed refund input must be refused, not crash").toBeGreaterThanOrEqual(400);
  expect(res.status(), "malformed refund input must not 500").toBeLessThan(500);
});

test("an admin can read customer records the customer role could not", async ({ request }) => {
  /* Non-vacuity for 00-identity's customer refusal: the same endpoint that refused a customer must
   * serve an admin, otherwise the RBAC assertions above prove only that the endpoint is broken. */
  const res = await request.get("/api/customer-360?customerId=E2E-CUS-UI-001");
  expect(res.status(), "admin must not be refused for lack of permission").not.toBe(403);
  expect(res.status(), "admin read must not be a server error").toBeLessThan(500);
});

// Controlled response regressions for employee UI states; these are not complete staff personas.
test("scheduling read failure is unknown, never an empty successful day", async ({ page }) => {
  let fail = true;
  await page.route("**/api/uat-scheduling?*", async route => {
    const date = new URL(route.request().url()).searchParams.get("date");
    await route.fulfill({status:fail?503:200, contentType:"application/json", body:JSON.stringify(fail?{error:"Schedule temporarily unavailable"}:{data:{date,providers:[],total:0}})});
  });
  await page.goto("/team/scheduling");
  await expect(page.getByRole("alert")).toContainText("Schedule temporarily unavailable");
  await expect(page.getByText("Schedule unavailable",{exact:true})).toBeVisible();
  await expect(page.getByText(/Nothing scheduled for/)).toHaveCount(0);
  fail=false;
  await page.getByRole("button",{name:"Refresh",exact:true}).click();
  await expect(page.getByText(/Nothing scheduled for/)).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("Control scheduling reads real rules and saves the selected location", async ({ page }) => {
  const saved:Array<Record<string,unknown>>=[];
  let submitted:Record<string,unknown>|undefined;
  await page.route("**/api/scheduling-rules",async route=>{
    if(route.request().method()==="POST"){
      submitted=route.request().postDataJSON();
      saved.push({id:"E2E-RULE",name:submitted?.name,service_code:submitted?.serviceCode,city_id:submitted?.cityId,zone_id:submitted?.zoneId,active:1});
      await route.fulfill({status:201,contentType:"application/json",body:JSON.stringify({data:{id:"E2E-RULE"}})});
    }else await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({data:saved})});
  });
  await page.goto("/control");
  await page.getByRole("button",{name:"Auto-scheduling",exact:false}).click();
  await page.getByRole("button",{name:"Scheduling rules",exact:true}).click();
  await expect(page.getByText("No custom scheduling rules are saved.")).toBeVisible();
  await page.getByLabel("Rule name",{exact:true}).fill("South zone rating");
  await page.getByLabel("Location",{exact:true}).selectOption("blr-south");
  await page.getByLabel("Required value",{exact:true}).fill("4.7");
  await page.getByRole("button",{name:"Save & activate rule",exact:true}).click();
  await expect(page.getByText("South zone rating",{exact:true})).toBeVisible();
  expect(submitted?.zoneId).toBe("blr-south");
  expect(submitted?.cityId).toBe("blr");
  await expect(page.getByRole("button",{name:"Create/reset test shortlist"})).toHaveCount(0);
});

test("a cancelled old reservation is not actionable after its group has been reassigned", async ({ page }) => {
  await page.route("**/api/uat-scheduling?*",async route=>{
    const date=new URL(route.request().url()).searchParams.get("date");
    const row={groupId:"REASSIGNED-GROUP",serviceCode:"grooming",zoneId:"blr-east",customerId:"E2E-CUS-UI-001",scheduledStart:`${date}T04:30:00Z`,scheduledEnd:`${date}T06:30:00Z`,occurrenceNumber:1,capacityUnits:1,decisionStatus:"assigned"};
    const providers=[{providerId:"OLD",providerName:"Previous provider",providerModel:"commission",reservations:[{...row,id:"OLD-ROW",status:"cancelled"}]},{providerId:"CURRENT",providerName:"Current provider",providerModel:"commission",reservations:[{...row,id:"CURRENT-ROW",status:"assigned"}]}];
    await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({data:{date,providers,total:2}})});
  });
  await page.goto("/team/scheduling");
  const actions=page.getByRole("button",{name:"Reassign",exact:true});
  await expect(actions).toHaveCount(2);
  await expect(actions.nth(0)).toBeDisabled();
  await expect(actions.nth(1)).toBeEnabled();
  await expect(page.getByText("cancelled",{exact:true})).toBeVisible();
});

test("confirmed bookings disable generic reassignment and explain service recovery", async ({ page }) => {
  await page.route("**/api/uat-scheduling?*",async route=>{
    const date=new URL(route.request().url()).searchParams.get("date");
    const row={id:"BOOKED-ROW",groupId:"BOOKED-GROUP",bookingId:"BOOKING-001",serviceCode:"grooming",zoneId:"blr-east",customerId:"E2E-CUS-UI-001",scheduledStart:`${date}T04:30:00Z`,scheduledEnd:`${date}T06:30:00Z`,occurrenceNumber:1,capacityUnits:1,status:"assigned",decisionStatus:"assigned"};
    await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({data:{date,providers:[{providerId:"CURRENT",providerName:"Current provider",providerModel:"commission",reservations:[row]}],total:1}})});
  });
  await page.goto("/team/scheduling");
  await expect(page.getByRole("button",{name:"Reassign",exact:true})).toBeDisabled();
  await expect(page.getByText("Booking BOOKING-001 · provider changes require service recovery.",{exact:true})).toBeVisible();
});
for (const outcome of ["assigned","awaiting_acceptance","ops_escalation","conflict","notifications"]) test(`employee recovery handles ${outcome} without a false confirmation`, async ({page})=>{
 await page.route("**/api/uat-scheduling?*",async route=>{const date=new URL(route.request().url()).searchParams.get("date");await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({data:{date,total:1,providers:[{providerId:"REAL-PROVIDER",providerName:"Original groomer",providerModel:"full_time",reservations:[{id:"REAL-ROW",groupId:"REAL-GROUP",bookingId:"REAL-BOOKING",bookingStatus:"assigned",canRecover:true,canRetryNotifications:true,serviceCode:"grooming",zoneId:"blr-east",customerId:"E2E-CUS-UI-001",scheduledStart:`${date}T04:30:00Z`,scheduledEnd:`${date}T06:30:00Z`,status:"assigned",decisionStatus:"assigned",occurrenceNumber:1,capacityUnits:1}]}]}})});});
 let sent:Record<string,unknown>|null=null;
 await page.route("**/api/provider-assignment-recovery",async route=>{sent=route.request().postDataJSON();await route.fulfill({status:outcome==="conflict"?409:outcome==="ops_escalation"?202:200,contentType:"application/json",body:JSON.stringify(outcome==="conflict"?{error:"Assignment changed; refresh before recovery"}:{data:{bookingId:"REAL-BOOKING",status:outcome,recoveryId:"CASE-REAL",replacement:outcome==="ops_escalation"?undefined:{id:"NEXT-PROVIDER",name:"Replacement groomer"},communications:{failed:0,enqueued:1}}})});});
 await page.goto("/team/scheduling");const submit=page.getByRole("button",{name:"Find replacement",exact:true});if(outcome==="notifications")await page.getByRole("button",{name:"Retry notifications",exact:true}).click();else{await page.getByRole("button",{name:"Recover provider",exact:true}).click();await expect(submit).toBeDisabled();await page.getByLabel("Recovery reason",{exact:true}).fill("Original groomer reported illness");if(outcome==="assigned")await page.screenshot({path:test.info().outputPath("employee-recovery-form.png"),fullPage:true});await submit.click();}
 await expect.poll(()=>sent).toEqual(outcome==="notifications"?{bookingId:"REAL-BOOKING",action:"retry_notifications"}:{bookingId:"REAL-BOOKING",providerId:"REAL-PROVIDER",action:"unavailable",reason:"Original groomer reported illness"});
 if(outcome==="notifications")await expect(page.getByRole("status")).toContainText("Notification retry finished: 1 queued. Delivery is not yet confirmed.");
 if(outcome==="assigned")await expect(page.getByRole("status")).toContainText("reassigned to Replacement groomer");
 if(outcome==="awaiting_acceptance")await expect(page.getByRole("status")).toContainText("partner acceptance is still pending");
 if(outcome==="ops_escalation")await expect(page.getByRole("status")).toContainText("Operations follow-up is required (case CASE-REAL)");
 if(outcome==="conflict"){await expect(page.getByRole("alert")).toContainText("Assignment changed");await expect(submit).toBeDisabled();await expect(page.getByLabel("Recovery reason",{exact:true})).toHaveValue("Original groomer reported illness");await page.getByRole("button",{name:"Refresh schedule",exact:true}).click();await expect(page.getByRole("button",{name:"Recover provider",exact:true})).toBeVisible();}
});

test("waiting requests remain visible when no provider holds a reservation",async({page})=>{
 await page.route("**/api/uat-scheduling?*",async route=>{
  const date=new URL(route.request().url()).searchParams.get("date");
  await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({data:{date,providers:[],total:0,pendingRequests:[{groupId:"WAITING-GROUP",status:"awaiting_admin",customerId:"WAITING-CUSTOMER",serviceCode:"grooming",zoneId:"blr-east",petCount:1,occurrences:[{start:`${date}T05:30:00.000Z`,end:`${date}T07:30:00.000Z`,occurrenceNumber:1}]}]}})});
 });
 await page.goto("/team/scheduling");
 const waiting=page.getByRole("region",{name:"Requests awaiting admin"});
 await expect(waiting).toBeVisible();await expect(waiting).toContainText("WAITING-GROUP");await expect(waiting).toContainText("WAITING-CUSTOMER");await expect(waiting).toContainText("11:00");
 await expect(page.getByText(/Nothing scheduled for/)).toHaveCount(0);
 await expect(waiting.getByText(/no confirmed provider assignment/)).toBeVisible();
});
