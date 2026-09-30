import {expect,test,type Page,type Route} from "@playwright/test";

const providerId="groom_kiran";
const day=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(Date.now()+86_400_000));
const feed={needsAction:[],today:[],upcoming:[],completed:[],needsOperations:[],past:[],counts:{}};

async function mount(page:Page,{editable=true,locked=false}:{editable?:boolean;locked?:boolean}={}){
 const writes:unknown[]=[];
 await page.route("**/api/**",async (route:Route)=>{
  const request=route.request(),url=new URL(request.url()),method=request.method();
  if(url.pathname==="/api/identity-session")return route.fulfill({json:{data:{subjectType:"provider",subjectId:providerId,roleCode:"service_provider"}}});
  if(url.pathname==="/api/uat-provider-switch")return route.fulfill({status:404,json:{error:"disabled"}});
  if(url.pathname==="/api/partner-jobs")return route.fulfill({json:{jobs:[]}});
  if(url.pathname==="/api/partner-job-feed")return route.fulfill({json:{data:feed}});
  if(url.pathname==="/api/provider-availability"&&method==="GET")return route.fulfill({json:{data:{providerId,cityId:"blr",providerModel:editable?"commission":"full_time",zones:["blr-east"],editable,days:locked?[{id:"OPS-LOCK",date:day(),zoneId:"blr-east",windows:["09:00-11:00"],state:"open",source:"operations",locked:true,updatedAt:1}]:[]}}});
  if(url.pathname==="/api/provider-availability"&&method==="PUT"){
   const body=request.postDataJSON();writes.push(body);
   return route.fulfill({json:{data:{id:"SELF",providerId,cityId:"blr",zoneId:body.zoneId,date:body.date,state:body.state,windows:body.windows,source:"partner_app",locked:false,updatedAt:2}}});
  }
  return route.fulfill({status:503,json:{error:"Unconfigured test API"}});
 });
 await page.goto("/v2/partner",{waitUntil:"domcontentloaded"});
 const essential=page.getByRole("button",{name:"Essential only",exact:true});if(await essential.isVisible().catch(()=>false))await essential.click();
 await page.getByRole("navigation",{name:"Partner mobile navigation"}).getByRole("button",{name:/More/}).click();
 return writes;
}

test("G17 commission provider can publish Open windows and a Blocked date in V2",async({page})=>{
 const writes=await mount(page);
 const card=page.getByRole("region",{name:"Availability calendar"});
 await expect(card).toBeVisible();
 await card.getByRole("button",{name:"Open",exact:true}).click();
 const times=card.locator('input[type="time"]');await times.nth(0).fill("10:00");await times.nth(1).fill("13:00");
 await card.getByRole("button",{name:"+ Add another window",exact:true}).click();
 await times.nth(2).fill("15:00");await times.nth(3).fill("18:00");
 await card.getByRole("button",{name:"Save Open windows",exact:true}).click();
 await expect(card.getByRole("status")).toContainText("Open for assignment");
 expect(writes[0]).toMatchObject({providerId,zoneId:"blr-east",state:"open",windows:["10:00-13:00","15:00-18:00"]});
 await card.getByRole("button",{name:"Blocked",exact:true}).click();
 await card.getByRole("button",{name:"Block this date",exact:true}).click();
 await expect(card.getByRole("status")).toContainText("Blocked for assignment");
 expect(writes[1]).toMatchObject({providerId,zoneId:"blr-east",state:"blocked",windows:[]});
});

test("G17 Operations-managed date is visible but cannot be widened in partner self-service",async({page})=>{
 await mount(page,{locked:true});
 const card=page.getByRole("region",{name:"Availability calendar"});await expect(card).toBeVisible();
 await expect(card.getByText(/Managed by Operations/)).toBeVisible();
 await expect(card.getByRole("button",{name:"Open",exact:true})).toBeDisabled();
 await expect(card.getByRole("button",{name:/Save Open windows|Block this date/})).toBeDisabled();
 await expect(card.getByText("09:00-11:00",{exact:true})).toBeVisible();
});

test("G17 full-time provider does not see commission calendar controls",async({page})=>{
 await mount(page,{editable:false});
 await expect(page.getByRole("region",{name:"Availability calendar"})).toHaveCount(0);
});

test("G17 mobile calendar stays within the V2 viewport",async({page})=>{
 await page.setViewportSize({width:390,height:844});await mount(page);
 await expect(page.getByRole("region",{name:"Availability calendar"})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
});
