import {test,expect} from '@playwright/test';
import {execFileSync} from 'node:child_process';
const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
for(const width of [320,360,390,412,768,820,1024,1440])for(const style of ['professional','cartoon'])test(`new Partner and staff presentation ${width} ${style}`,async({page},info)=>{
 const theme=width%3===0?'signature':width%3===1?'emerald':'coral',mode=style==='cartoon'?'dark':'light',writes:string[]=[];
 await page.setViewportSize({width,height:900});
 await page.addInitScript(({style,theme,mode})=>{localStorage.setItem('pawspace.visual-style',style);localStorage.setItem('pawspace.customer.theme',theme);localStorage.setItem('pawspace.customer.appearance',mode);localStorage.setItem('pawspace.cookie-consent','essential');},{style,theme,mode});
 await page.route('**/api/**',async route=>{const r=route.request();if(r.method()!=='GET')writes.push(new URL(r.url()).pathname);if(new URL(r.url()).pathname==='/api/team-overview')return route.fulfill({json:{data:{actor:{name:'Synthetic reviewer',email:'fixture@test.invalid',roleCode:'founder',permissions:['*']},today:'2026-10-01',commandStrip:{},workspaces:{}}}});return route.fulfill({status:401,json:{error:'Isolated UI fixture'}});});
 await page.goto('/partner');await expect(page.getByRole('heading',{name:'Partner UAT hub'})).toBeVisible();await page.evaluate(()=>document.fonts.ready);
 const partner=page.locator('main').getByRole('link',{name:'Open all assigned jobs →',exact:true});await expect(partner).toHaveAttribute('href','/partner/jobs');expect((await partner.boundingBox())!.height).toBeGreaterThanOrEqual(48);await partner.focus();expect(await partner.evaluate(e=>getComputedStyle(e).outlineStyle)).not.toBe('none');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+2);await page.screenshot({path:info.outputPath(`partner-${head}.png`),fullPage:true});
 await page.goto('/team');await expect(page.locator('[data-staff-workspace=true]')).toBeVisible();await page.evaluate(()=>document.fonts.ready);
 await expect(page.locator('#staff-workspace-navigation')).toContainText('Synthetic reviewer');
 if(width<=800){const open=page.locator('button[aria-controls="staff-workspace-navigation"]');expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(48);await open.click();await expect(open).toHaveAttribute('aria-expanded','true');}
 const finder=page.getByRole('searchbox',{name:'Find a workspace'});await expect(finder).toBeVisible();expect((await finder.boundingBox())!.height).toBeGreaterThanOrEqual(48);await finder.fill('Customer');await expect(page.locator('#staff-workspace-navigation').getByRole('link',{name:'Customer 360',exact:true})).toBeVisible();await finder.focus();expect(await finder.evaluate(e=>getComputedStyle(e).outlineStyle)).not.toBe('none');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+2);await page.screenshot({path:info.outputPath(`staff-${head}.png`),fullPage:true});expect(writes).toEqual([]);await info.attach('source-and-device',{body:JSON.stringify({head,width,style,theme,mode,writes,physicalDevice:false}),contentType:'application/json'});
});
