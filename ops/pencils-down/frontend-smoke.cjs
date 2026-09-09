'use strict';
// One read-only customer-shell browser smoke. Not a booking/payment test.
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const root = process.env.GITHUB_WORKSPACE;
const req = createRequire(path.join(root, 'candidate/package.json'));
const {chromium} = req('playwright');
const evidence = path.join(root,'pencils-down-evidence');
const file = path.join(evidence,'report.json');
const report = JSON.parse(fs.readFileSync(file,'utf8'));
async function main() {
  if (report.outcome !== 'ISOLATED_APPLICATION_HTTP_READY' || report.candidate !== 'ab40dc009471e0fdac41b07034aaef18784f0a02') throw new Error('No verified frozen HTTP deployment.');
  const origin = new URL(report.origin);
  if (!/^pawspace-beta-ab40dc00\.[a-z0-9-]+\.workers\.dev$/.test(origin.hostname) || origin.protocol!=='https:') throw new Error('Unapproved origin.');
  const browser=await chromium.launch({headless:true});
  const errors=[], blocked=new Set();
  try {
    const context=await browser.newContext({viewport:{width:390,height:844}, serviceWorkers:'block'});
    await context.route('**/*', async route=>{
      const url=new URL(route.request().url());
      if(url.origin===origin.origin || ['data:','blob:'].includes(url.protocol)) return route.continue();
      blocked.add(url.hostname); return route.abort();
    });
    const page=await context.newPage();
    page.on('pageerror', e=>errors.push(e.name));
    const response=await page.goto(origin.origin+'/mobile-app',{waitUntil:'domcontentloaded',timeout:60000});
    await page.getByText(/PawSpace/i).first().waitFor({state:'visible',timeout:20000});
    await page.waitForTimeout(2000);
    const body=await page.locator('body').innerText();
    const buttons=await page.getByRole('button').count();
    await page.screenshot({path:path.join(evidence,'customer-app-mobile.png'),fullPage:true});
    const result={httpStatus:response?.status(),pawspaceVisible:/pawspace/i.test(body),buttonCount:buttons,
      pageErrorCount:errors.length, pageErrorTypes:errors, blockedExternalHosts:[...blocked],
      bookingPerformed:false,paymentPerformed:false};
    report.checks.customer_shell_browser=result;
    if(response?.status()!==200 || !result.pawspaceVisible || !buttons || errors.length) throw new Error('Customer-shell browser smoke failed.');
    report.outcome='ISOLATED_FRONTEND_DEPLOYMENT_AND_SHELL_SMOKE_PASS';
  } finally {await browser.close();fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');}
}
main().catch(error=>{
  report.outcome='BROWSER_SMOKE_FAILED'; report.browser_error=error.message;
  fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');
  console.error(error.message);process.exitCode=1;
});
