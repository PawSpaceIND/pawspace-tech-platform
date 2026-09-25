import {test,expect,type Page} from "@playwright/test";
async function shellFixture(page:Page){
 await page.route("**/api/**",async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==="/api/identity-session"||path==="/api/customer-account")return route.fulfill({status:401,json:{error:"Sign in required"}});
  if(path==="/api/service-availability")return route.fulfill({status:200,json:{data:[
   {code:"grooming",enabled:true},{code:"boarding",enabled:true},{code:"dog_training",enabled:true},{code:"pet_sitting",enabled:true},
   {code:"dog_walking",enabled:true},{code:"food",enabled:true},{code:"relocation",enabled:true},{code:"pet_taxi",enabled:true}
  ]}});
  return route.fulfill({status:404,json:{error:"Outside V2 shell fixture"}});
 });
}
test("V2 customer shell keeps all service and utility navigation inside V2",async({page})=>{
 await shellFixture(page); await page.goto("/v2");
 await expect(page.getByRole("heading",{name:/Everything your pet needs/})).toBeVisible();
 for(const route of ["grooming","boarding","training","sitting","walking","food","relocation","taxi"]){
  await expect(page.locator('a[href="/v2/'+route+'"]')).toHaveCount(1);
 }
 await expect(page.locator('a[href="/v2/chat"]:visible').first()).toBeVisible();
 await expect(page.locator('a[href="/v2/activity"]:visible').first()).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});
test("V2 utility routes render signed-out recovery without legacy customer-app hops",async({page})=>{
 await shellFixture(page);
 await page.goto("/v2/activity"); await expect(page.getByRole("heading",{name:/Sign in to see your care history/})).toBeVisible();
 await expect(page.locator('a[href="/mobile-app"]')).toHaveCount(0);
 await page.goto("/v2/account"); await expect(page.getByRole("heading",{name:/You are signed out/})).toBeVisible();
 await expect(page.locator('a[href="/mobile-app"]')).toHaveCount(0);
 await page.goto("/v2/chat"); await expect(page.getByRole("heading",{name:/Ask PawSpace anything/})).toBeVisible();
 await expect(page.locator('main[data-identity="guest"]')).toBeVisible();
 const accountMode=page.getByRole("button",{name:"My PawSpace"});
 await accountMode.click();
 await expect(accountMode).toHaveAttribute("aria-pressed","true");
 await expect(page.getByText(/Sign in from the V2 home/)).toBeVisible();
});
