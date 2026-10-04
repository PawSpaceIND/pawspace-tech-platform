import { expect, test, type Page } from "@playwright/test";
import { fixtureFor, tableRoutes, canonicalTableRoutes } from "./ui-audit-layout-fixtures";
import {emptyComplianceFixture} from "./ui-audit-detail-fixtures";

async function ready(page: Page, route: string) {
  await page.goto(route, {waitUntil:"domcontentloaded"});
  if(route.startsWith("/v2")) await expect(page.locator("[data-pawspace-v2]")).toBeAttached();
  await expect(page.locator('[data-staff-workspace="true"]')).toBeVisible();
  await expect(page.locator('[data-paw-appearance-slot] .paw-appearance-trigger')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  // These workspaces poll in the background: wait for rendered UI, not network silence.
  await expect(page.locator('[data-paw-appearance-slot] .paw-appearance-trigger')).toHaveCSS("position","static");
  const consent=page.getByRole("button",{name:"Essential only",exact:true});
  if(await consent.isVisible()) await consent.click();
  await page.evaluate(()=>window.scrollTo({top:0,behavior:"instant"}));
}
test.beforeEach(async ({context,page}) => {
  const login=await context.request.post("/api/staging-login",{data:{action:"login",code:process.env.PW_STAFF_UAT_ACCESS_CODE||"pawspace-e2e-access-only",email:"founder@pawspace.in"}});
  expect(login.status()).toBe(200);
  await page.route("**/api/**",async route => {
    if (route.request().method() !== "GET") return route.abort("blockedbyclient");
    const data=fixtureFor(new URL(route.request().url()));
    if(data!==undefined) await route.fulfill({json:{data}}); else await route.continue();
  });
});
const viewports=[{width:390,height:844},{width:768,height:1024},{width:1440,height:1000}];
for(const viewport of viewports) for(const theme of ["emerald","signature","coral"]) for(const mode of ["light","dark"]) for(const style of ["professional","cartoon"]) {
 test(`financial tables and controls ${viewport.width}/${theme}/${mode}/${style}`,async ({page},info)=>{
  const errors:string[]=[];
  page.on("pageerror",error=>errors.push(error.message));
  page.on("console",message=>{if(message.type()==="error"&&/hydration|server rendered HTML|uncaught/i.test(message.text())) errors.push(message.text());});
  await page.setViewportSize(viewport);
  await page.addInitScript(({theme,mode,style})=>{localStorage.setItem("pawspace.customer.theme",theme);localStorage.setItem("pawspace.customer.appearance",mode);localStorage.setItem("pawspace.visual-style",style);},{theme,mode,style});
  for(const route of tableRoutes) {
   await ready(page,route);
   // Seeded legacy palette/style keys are migration metadata only (app/mobile-app/theme-config.ts): each one renders
   // the approved Editorial theme in the professional style, while the seeded light/dark mode is honoured.
   await expect(page.locator("html")).toHaveAttribute("data-paw-theme","editorial");
   await expect(page.locator("html")).toHaveAttribute("data-paw-mode",mode);
   await expect(page.locator("html")).toHaveAttribute("data-paw-style","professional");
   await expect(page.locator("table").first()).toBeVisible();
   const measured=await page.locator("table").evaluateAll(tables=>tables.map(table=>{
    const broken:string[]=[]; const walker=document.createTreeWalker(table,NodeFilter.SHOW_TEXT);
    let node:Node|null;
    while((node=walker.nextNode())) {
     const text=node.textContent||"";
     // Identifiers can wrap at separators; individual words and amounts cannot.
     for(const match of text.matchAll(/₹[\d,.]+|[A-Za-z0-9_]{4,}/g)) {
      const range=document.createRange();range.setStart(node,match.index!);range.setEnd(node,match.index!+match[0].length);
      const lines=new Set(Array.from(range.getClientRects()).filter(r=>r.width>0).map(r=>Math.round(r.top)));
      if(lines.size>1) broken.push(match[0]);
     }
    }
    const wrapper=table.parentElement!; wrapper.scrollLeft=wrapper.scrollWidth;
    return {layout:getComputedStyle(table).tableLayout,width:table.getBoundingClientRect().width,
      parentTag:wrapper.tagName,wrapperOverflow:getComputedStyle(wrapper).overflowX,wrapperWidth:wrapper.clientWidth,
      lastRight:table.querySelector("tr")?.lastElementChild?.getBoundingClientRect().right||0,
      wrapperRight:wrapper.getBoundingClientRect().right,broken};
   }));
   for(const table of measured) {
    expect.soft(table.layout,route).toBe("auto");
    expect.soft(table.width,route).toBeGreaterThanOrEqual(672);
    expect.soft(table.broken,route).toEqual([]);
    expect.soft(table.wrapperOverflow,`${route} ${table.parentTag}`).toMatch(/auto|scroll/);
    expect.soft(table.lastRight,`${route}: final column remains reachable`).toBeLessThanOrEqual(table.wrapperRight+3);
   }
   expect.soft(await page.evaluate(()=>document.documentElement.scrollWidth),`${route}: document overflow`).toBeLessThanOrEqual(viewport.width+2);
   expect.soft(await page.locator('.paw-appearance-trigger').evaluate(e=>getComputedStyle(e).position),`${route}: utility must not overlay content`).toBe("static");
   await page.locator("table").first().scrollIntoViewIfNeeded();
   await page.screenshot({path:info.outputPath(route.replaceAll("/","_")+".jpg"),type:"jpeg",quality:65});
  }
  expect(errors).toEqual([]);
 });
}

test("persistent form labels, complete selectors and appearance dialog",async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await ready(page,"/v2/team/marketing");
 for(const name of ["Campaign name","Objective","Service code","Budget (₹)","Holdout (%)"]) await expect(page.getByLabel(name,{exact:true})).toBeVisible();
 await ready(page,"/v2/team/subscriptions");
 await expect(page.getByLabel("Customer ID",{exact:true})).toBeVisible();
 await expect(page.getByLabel("Booking ID",{exact:true})).toBeVisible();
 await expect(page.getByText("Booking ID for reserve / release",{exact:true})).toBeVisible();
 await ready(page,"/v2/team/analytics");
 const select=page.getByRole("combobox",{name:"Quick range",exact:true});
 await expect(select).toHaveCSS("white-space","nowrap");
 expect((await select.boundingBox())!.width).toBeGreaterThan(240);
 await page.getByRole("button",{name:"Change PawSpace appearance"}).click();
 await expect(page.getByRole("dialog")).toBeVisible();
 await page.getByRole("button",{name:"Done",exact:true}).click();
 await expect(page.getByRole("dialog")).not.toBeVisible();
});

test("empty finance sections distinguish empty from loading",async({page})=>{
 await ready(page,"/v2/team/people/finance");
 await expect(page.getByText("No payroll Finance posts recorded yet.",{exact:true})).toBeVisible();
 await expect(page.getByText("No sandbox reconciliation references recorded yet.",{exact:true})).toBeVisible();
});

for(const viewport of viewports) {
 test(`staff detail layouts ${viewport.width}`,async({page},info)=>{
  await page.setViewportSize(viewport);
  const withinDocument=async()=>{
   const measured=await page.evaluate(()=>({width:document.documentElement.scrollWidth,path:location.pathname,scrollX,innerWidth,overflow:Array.from(document.querySelectorAll('body *')).filter(e=>e.getBoundingClientRect().right+scrollX+(getComputedStyle(e).overflowX==="visible"?Math.max(0,e.scrollWidth-e.clientWidth):0)>innerWidth+2&&getComputedStyle(e).display!=="none").slice(0,12).map(e=>({tag:e.tagName,cls:e.className,right:e.getBoundingClientRect().right,text:e.textContent?.slice(0,90)}))}));
   expect.soft(measured.width,JSON.stringify(measured)).toBeLessThanOrEqual(viewport.width+2);
  };
  await ready(page,"/v2/team/provider-onboarding");
  await expect(page.locator('[data-audit-identifier]')).toContainText("uat_pay_beneficiary");
  await withinDocument();
  await page.locator('[data-audit-identifier]').scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath("provider-detail.png")});
  await ready(page,"/v2/team/performance");
  const removals=page.getByRole("button",{name:"Remove",exact:true});
  await expect(removals).toHaveCount(3);
  for(const button of await removals.all()) {await expect(button).toHaveCSS("white-space","nowrap");expect((await button.boundingBox())!.width).toBeGreaterThan(75);}
  await withinDocument();
  await removals.first().scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath("roster-actions.png")});
  await ready(page,"/v2/control");
  const badge=page.locator('i[data-signal-severity="critical"]');
  await expect(badge).toHaveText("Action required");
  if(viewport.width===390) await expect(badge).toHaveCSS("white-space","nowrap");
  await withinDocument();
  await badge.scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath("control-badge.png")});
  await ready(page,"/v2/employee");
  await expect(page.getByRole("heading",{name:"Hello, UI",exact:true})).toBeVisible();
  const from=page.getByLabel("From",{exact:true});
  await expect(from).toBeVisible();
  expect.soft((await from.boundingBox())!.width).toBeGreaterThanOrEqual(150);
  const attendance=page.locator('table').last();await expect(attendance).toContainText("missing_checkout");
  expect.soft(await attendance.evaluate(e=>getComputedStyle(e).tableLayout)).toBe("auto");
  await withinDocument();
  await from.scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath("employee-date-fields.png")});
  await ready(page,"/v2/team/ai");
  const executionScope=page.getByText("low_risk_internal_only",{exact:true});
  await expect(executionScope).toBeVisible();
  await expect(executionScope).toHaveCSS("overflow-wrap","anywhere");
  const formatted=page.locator('.paw-readable-text').first();await expect(formatted).toContainText("Important review");
  await expect(formatted.locator('strong')).toHaveText("Important review");
  await expect(formatted.locator('li')).toHaveCount(2);
  await expect(formatted.locator('ul')).toHaveCSS('list-style-type','disc');
  await expect(formatted.locator('code')).toHaveText("reference");
  await expect(formatted.locator('untrusted-tag')).toHaveCount(0);
  await expect(formatted).toContainText("<untrusted-tag>");
  await formatted.scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath("atlas-formatting.png")});
  await withinDocument();
  await ready(page,"/v2/team/finance/boarding");
  const rows=page.locator('[data-audit-queue-row]');await expect(rows).toHaveCount(2);
  const buttons=rows.getByRole("button",{name:"Open booking",exact:true});
  const boxes=await buttons.evaluateAll(elements=>elements.map(e=>e.getBoundingClientRect().toJSON()));
  expect.soft(Math.abs(boxes[0].x-boxes[1].x)).toBeLessThan(2);
  await withinDocument();
  await rows.first().scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath("boarding-queue.png")});
 });
}

for(const theme of ["emerald","signature","coral"]) for(const mode of ["light","dark"]) for(const style of ["professional","cartoon"]) {
 test(`tracking palette and bounded lists ${theme}/${mode}/${style}`,async({page},info)=>{
  await page.addInitScript(({theme,mode,style})=>{localStorage.setItem("pawspace.customer.theme",theme);localStorage.setItem("pawspace.customer.appearance",mode);localStorage.setItem("pawspace.visual-style",style);},{theme,mode,style});
  for(const viewport of viewports) {
   await page.setViewportSize(viewport);await ready(page,"/v2/team/operations/live-tracking");
   // Legacy seeds never render (see the financial tables test): Editorial, professional, seeded mode.
   await expect(page.locator('html')).toHaveAttribute('data-paw-theme','editorial');
   await expect(page.locator('html')).toHaveAttribute('data-paw-mode',mode);
   await expect(page.locator('html')).toHaveAttribute('data-paw-style','professional');
   await expect(page.getByText("UI-BOOKING-44",{exact:true})).toBeAttached();
   const main=page.getByRole('heading',{name:'Live tracking control',exact:true}).locator('xpath=ancestor::main[1]');
   const colors=await main.evaluate(e=>{
    const actual=getComputedStyle(e).backgroundColor;const probe=document.createElement('span');
    probe.style.color='var(--paw-bg)';e.appendChild(probe);const expected=getComputedStyle(probe).color;probe.remove();return {actual,expected};
   });
   expect.soft(colors.actual).toBe(colors.expected);
   const rows=main.locator('div[class*="rows"]').first();
   await expect(rows).toHaveCSS('overflow-y','auto');
   const bounds=await rows.evaluate(e=>({height:e.clientHeight,total:e.scrollHeight}));
   expect.soft(bounds.height).toBeLessThanOrEqual(viewport.height*.66+2);expect.soft(bounds.total).toBeGreaterThan(bounds.height);
   const first=main.locator('section[class*="grid"] > article').first();
   const second=main.locator('section[class*="grid"] > article').nth(1);
   expect.soft((await first.boundingBox())!.width).toBeGreaterThan(viewport.width===1440?400:viewport.width*.65);
   expect.soft((await second.boundingBox())!.height).toBeLessThan((await first.boundingBox())!.height);
   if(viewport.width===1440)expect.soft((await first.boundingBox())!.width/(await second.boundingBox())!.width).toBeCloseTo(1.4,1);
   expect.soft(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width+2);
   await page.screenshot({path:info.outputPath(`tracking-${viewport.width}.png`)});
  }
 });
}

for(const viewport of viewports) {
 test(`remaining tables and field alignment ${viewport.width}`,async({page},info)=>{
  await page.setViewportSize(viewport);
  await ready(page,"/v2/team/finance/training");
  await expect(page.getByText("0/0",{exact:true})).toBeVisible();
  await expect(page.getByText("Training finance error",{exact:true})).not.toBeVisible();
  await expect(page.locator('table')).toHaveCount(3);
  for(const table of await page.locator('table').all()) {
   await expect(table).toHaveCSS('table-layout','auto');
   expect.soft((await table.boundingBox())!.width).toBeGreaterThanOrEqual(672);
   expect.soft(await table.evaluate(e=>getComputedStyle(e.parentElement!).overflowX)).toMatch(/auto|scroll/);
  }
  expect.soft(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width+2);
  const configuration=page.getByRole('button',{name:'Publish trainer rate',exact:true});
  await configuration.scrollIntoViewIfNeeded();
  for(const name of ['Publish trainer rate','Configure tax policy','Configure cancellation policy']) {
   const button=page.getByRole('button',{name,exact:true});
   const shape=await button.evaluate(e=>{
    const box=e.getBoundingClientRect(),broken:string[]=[];const walker=document.createTreeWalker(e,NodeFilter.SHOW_TEXT);let node:Node|null;
    while((node=walker.nextNode()))for(const match of (node.textContent||'').matchAll(/[A-Za-z]{4,}/g)){
     const range=document.createRange();range.setStart(node,match.index!);range.setEnd(node,match.index!+match[0].length);
     const rects=Array.from(range.getClientRects()).filter(r=>r.width>0);
     if(new Set(rects.map(r=>Math.round(r.top))).size>1||rects.some(r=>r.right>box.right+2||r.bottom>box.bottom+2))broken.push(match[0]);
    }
    return {height:box.height,broken};
   });
   expect.soft(shape.broken,name).toEqual([]);
   expect.soft(shape.height,name+': control must not stretch to a paragraph height').toBeLessThanOrEqual(96);
  }
  await page.screenshot({path:info.outputPath('training-finance.png')});
  await ready(page,"/v2/team/finance-compliance");
  const tds=page.getByRole('region',{name:'TDS deductions table; scroll horizontally for all columns'});
  await expect(tds.locator('thead th')).toHaveCount(6);
  await expect(tds.locator('tbody')).toContainText('UI-DEDUCTEE-1');
  await expect(tds.locator('table')).toHaveCSS('table-layout','auto');
  await expect(tds).toHaveCSS('overflow-x','auto');
  await tds.scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath('tds-table.png')});
  await page.route('**/api/statutory-compliance**',route=>route.request().method()==='GET'?route.fulfill({json:{data:emptyComplianceFixture}}):route.abort('blockedbyclient'));
  await ready(page,"/v2/team/finance-compliance");
  await expect(tds.getByText('No deductions computed for this period yet.',{exact:true})).toBeVisible();
  await expect(tds.locator('thead th')).toHaveCount(6);
  const headerY=await tds.locator('thead th').evaluateAll(cells=>cells.map(e=>e.getBoundingClientRect().y));
  expect.soft(Math.max(...headerY)-Math.min(...headerY)).toBeLessThan(2);
  await tds.scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath('tds-empty.png')});
  await ready(page,"/v2/team/customer-reminders");
  const fields=[page.getByLabel('Grooming rebooking (days)',{exact:true}),page.getByLabel('Subscription inactivity (days)',{exact:true}),page.getByLabel('Renewal reminder window (days)',{exact:true})];
  for(const input of fields)await expect(input).toBeVisible();
  if(viewport.width>=768) {const boxes=await Promise.all(fields.map(input=>input.boundingBox()));const bottoms=boxes.map(b=>b!.y+b!.height);expect.soft(Math.max(...bottoms)-Math.min(...bottoms)).toBeLessThan(2);}
  await fields[0].scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath('reminder-fields.png')});
 });
}

for(const viewport of viewports) {
 test(`master detail scroll containment ${viewport.width}`,async({page},info)=>{
  await page.setViewportSize(viewport);
  await ready(page,"/v2/team/ai/handoff");
  const list=page.locator('[data-audit-list-detail] > aside');
  await expect(list.getByRole('button',{name:/UI Conversation 79/})).toBeAttached();
  await expect(list).toHaveCSS('overflow-y','auto');
  const sizes=await list.evaluate(e=>({client:e.clientHeight,scroll:e.scrollHeight}));
  expect.soft(sizes.scroll).toBeGreaterThan(sizes.client);
  expect.soft(sizes.client).toBeLessThanOrEqual(viewport.height*(viewport.width===390?.46:.73));
  await list.getByRole('button',{name:/UI Conversation 79/}).scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath('handoff-list-end.png')});
  await ready(page,"/v2/crm");
  const crm=page.locator('[class*="customerList"]').first();await expect(crm).toBeVisible();
  await expect(crm).toHaveCSS('overflow-y','auto');
  expect.soft(await crm.evaluate(e=>getComputedStyle(e).maxHeight)).not.toBe('none');
  await page.screenshot({path:info.outputPath('crm-list.png')});
  await ready(page,"/v2/team/catalogue");
  const pricing=page.locator('aside[class*="_list_"]').first();await expect(pricing).toBeVisible();
  await expect(pricing).toHaveCSS('overflow-y','auto');
  expect.soft(await pricing.evaluate(e=>getComputedStyle(e).maxHeight)).not.toBe('none');
  expect.soft(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width+2);
  await pricing.scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath('pricing-list.png')});
 });
}

for(const viewport of viewports) {
 test(`open audit follow-ups ${viewport.width}`,async({page},info)=>{
  await page.setViewportSize(viewport);
  await ready(page,"/v2/team/whatsapp/templates");
  const row=page.locator("table tbody tr").first();
  await expect(row).toBeVisible();
  const overflow=await row.locator("td").evaluateAll(cells=>cells.slice(0,4).map((cell,index)=>{
   const cellBox=cell.getBoundingClientRect();
   const offenders=Array.from(cell.querySelectorAll("b,small,span")).filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&(r.right>cellBox.right+1||r.left<cellBox.left-1);}).map(el=>({text:el.textContent?.trim(),right:el.getBoundingClientRect().right,cellRight:cellBox.right}));
   return {index,cellWidth:cellBox.width,offenders};
  }));
  expect.soft(overflow.flatMap(cell=>cell.offenders),JSON.stringify(overflow)).toEqual([]);
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath("whatsapp-template-cells.png")});

  await ready(page,"/v2/team/ai/handoff");
  const detail=page.locator('[data-audit-list-detail] > article');
  await expect(detail.getByText("No Gate-4 handoff is active or recorded for this thread.",{exact:true})).toBeVisible();
  const detailBox=await detail.boundingBox();
  expect.soft(detailBox!.height,"empty handoff detail should size to content instead of a large blank card").toBeLessThan(320);
  await detail.scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath("handoff-empty-detail.png")});

  await page.route("**/api/ai-human-handoff?threadId=**",route=>route.fulfill({json:{data:{current:{status:"staff_active",reason:"customer_request",queue_code:"customer_experience",confidence:.9,summary:{transcript:[{direction:"inbound",channel:"web",text:"Synthetic populated handoff"}]}},aiPaused:true,sameCanonicalThread:true}}}));
  await ready(page,"/v2/team/ai/handoff");
  expect.soft((await detail.boundingBox())!.height,"populated handoff detail keeps its established workspace depth").toBeGreaterThanOrEqual(560);
  await detail.scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath("handoff-populated-detail.png")});

  await page.route("**/api/conversations?status=open",route=>route.fulfill({json:{data:{threads:[]}}}));
  await page.route("**/api/ai-human-handoff?mode=queue",route=>route.fulfill({json:{data:{queue:[]}}}));
  await ready(page,"/v2/team/ai/handoff");
  await expect(detail.getByText("Select a thread.",{exact:true})).toBeVisible();
  expect.soft((await detail.boundingBox())!.height,"no-thread handoff detail should size to its single empty-state line").toBeLessThan(320);
  await detail.scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath("handoff-no-thread-detail.png")});
 });
}

test('canonical staff routes retain the shared table and utility repairs',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 for(const route of canonicalTableRoutes) {
  await ready(page,route);
  await expect(page.locator('table').first()).toHaveCSS('table-layout','auto');
  expect.soft(await page.evaluate(()=>document.documentElement.scrollWidth),route).toBeLessThanOrEqual(392);
  await expect(page.locator('[data-paw-appearance-slot] .paw-appearance-trigger')).toHaveCSS('position','static');
 }
});

for(const viewport of viewports) test(`review corrections preserve text and region identity ${viewport.width}`,async({page},info)=>{
 await page.setViewportSize(viewport);
 for(const [route,names] of [
  ['/v2/team/customer-reminders',['Outcomes by reminder type','Recent sweep events']],
  ['/v2/team/finance',['By service','Bookings and their payment state']],
 ] as const) {
  await ready(page,route);
  for(const name of names) {
   const table=page.getByRole('region',{name:`${name}; scroll horizontally for all columns`,exact:true});
   await expect(table).toHaveCount(1);await expect(table).toHaveAttribute('tabindex','0');
   await expect(table).toHaveCSS('overflow-x','auto');
  }
 }
 await page.route('**/api/admin/atlas-chat?*',route=>route.fulfill({json:{data:{messages:[{id:'UI-REVIEW-TEXT',role:'atlas',createdAt:0,content:'3. First\n5. Second\n5. Repeated\n1. Restart\n\nCustomer    Net amount\n**\n`'}]}}}));
 await ready(page,'/v2/team/ai');
 const formatted=page.locator('.paw-readable-text').first();
 await expect(formatted.locator('ol li')).toHaveCount(4);
 expect(await formatted.locator('ol li').evaluateAll(items=>items.map(item=>item.getAttribute('value')))).toEqual(['3','5','5','1']);
 await expect(formatted).toHaveCSS('white-space','pre-wrap');
 await expect(formatted.locator('p').first()).toHaveText('Customer    Net amount',{useInnerText:false});
 expect(await formatted.locator('p').first().textContent()).toBe('Customer    Net amount');
 await expect(formatted.locator('p').nth(1)).toHaveText('**');
 await expect(formatted.locator('p').nth(2)).toHaveText('`');
 await formatted.scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath(`review-text-${viewport.width}.png`)});
});

for(const width of [390,768,1440,1920])test(`reviewed statistic grid and shared table landmarks ${width}`,async({page},info)=>{
 await page.setViewportSize({width,height:1000});
 await page.route('**/api/boarding-ops',route=>route.fulfill({json:{data:{source:'ui-only',generatedAt:0,stays:[],metrics:{total:7,clear:1,needsAttention:6,recovery:2,openIncidents:3,financeReview:4,mediaBlocked:5},readiness:{engineeringGate:'uat',productionReady:false,externalDependencies:{}}}}}));
 await ready(page,'/v2/team/operations/boarding');
 const cards=page.locator('[data-staff-grid="stats"] > *');await expect(cards).toHaveCount(7);
 const boxes=await cards.evaluateAll(items=>items.map(item=>item.getBoundingClientRect().toJSON()));
 for(const box of boxes){expect(box.width).toBeGreaterThanOrEqual(179);expect(box.right).toBeLessThanOrEqual(width+1);}
 if(width===1920)expect(new Set(boxes.map(box=>Math.round(box.y))).size).toBe(1);
 if(width===1440)expect(new Set(boxes.map(box=>Math.round(box.y))).size).toBeGreaterThan(1);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+2);
 await page.screenshot({path:info.outputPath(`seven-statistics-${width}.png`)});
 await ready(page,'/v2/team/voice');
 const regions=page.locator('[role="region"][aria-label^="Table:"]');
 await expect(regions.first()).toBeVisible();
 const names=await regions.evaluateAll(items=>items.map(item=>item.getAttribute('aria-label')));
 expect(names.length).toBeGreaterThanOrEqual(2);expect(new Set(names).size).toBe(names.length);
 expect(names).toContain('Table: Setting / State / Detail; scroll horizontally for all columns');
 await expect(page.getByRole('combobox',{name:'Use case',exact:true})).toHaveCount(1);
 await page.screenshot({path:info.outputPath(`shared-table-landmarks-${width}.png`)});
});

// F-002 reopened on deployed staging: real customer IDs use unbroken hex segments.
for (const viewport of viewports) {
 test(`live retest keeps long request identifiers inside their cells ${viewport.width}`, async ({page}, info) => {
  await page.setViewportSize(viewport);
  const rows=fixtureFor(new URL('http://127.0.0.1/api/meet-and-greet')) as Array<Record<string,unknown>>;
  const customerId='CUS-OTP-'+ 'A1B2C3D4'.repeat(4);
  await page.route('**/api/meet-and-greet',route=>route.request().method()==='GET'
   ? route.fulfill({json:{data:[{...rows[0],id:'MGR-'+ 'C9D8E7F6'.repeat(4),customerId,hostProviderId:'ui_host_grooming',bookingId:'PS-UAT-SIT-'+ 'B1C2D3E4'.repeat(3)},rows[0]]}})
   : route.abort('blockedbyclient'));
  await ready(page,'/v2/team/meet-and-greet');
  const cell=page.locator('table tbody tr').first().locator('td').first();
  await expect(cell).toContainText(customerId);
  await cell.scrollIntoViewIfNeeded();
  const spill=await cell.evaluate(element=>{
   const box=element.getBoundingClientRect(),out:string[]=[];
   const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);let node:Node|null;
   while((node=walker.nextNode())) {
    if(!node.textContent?.trim())continue;
    const range=document.createRange();range.selectNodeContents(node);
    if(Array.from(range.getClientRects()).some(r=>r.right>box.right+1||r.left<box.left-1))out.push(node.textContent);
   }
   return out;
  });
  await page.screenshot({path:info.outputPath(`long-request-${viewport.width}.png`)});
  expect(spill,'Identifier text must not paint inside adjacent price/date columns').toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width+2);
 });
}
