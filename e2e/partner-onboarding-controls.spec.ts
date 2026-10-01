import {test,expect,type Locator} from '@playwright/test';
import {execFileSync} from 'node:child_process';
const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const baseline=process.env.UI_ONBOARDING_BASELINE==='true';
async function measure(locator:Locator){return locator.evaluate(element=>{
 const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
 const parse=(s:string)=>{if(!/^rgba?\(/.test(s))throw new Error(`Unsupported colour ${s}`);return s.match(/[\d.]+/g)!.map(Number);};
 let ancestor:Element|null=element,bg:number[]|null=null;
 while(ancestor){const c=parse(getComputedStyle(ancestor).backgroundColor);if((c[3]??1)===1){bg=c;break;}if((c[3]??1)!==0)throw new Error('Translucent background requires separate review');ancestor=ancestor.parentElement;}
 if(!bg)throw new Error('No opaque background');const fg=parse(style.color);if((fg[3]??1)!==1)throw new Error('Translucent foreground');
 const luminance=(c:number[])=>c.slice(0,3).map(v=>{const s=v/255;return s<=.04045?s/12.92:((s+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
 const a=luminance(fg),b=luminance(bg);return {width:rect.width,height:rect.height,contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),foreground:style.color,background:bg};
 });}
for(const width of [320,391,768,1440])for(const style of ['professional','cartoon'])for(const theme of ['emerald','signature','coral'])for(const mode of ['light','dark']){
 test(`onboarding controls ${width} ${style} ${theme} ${mode}`,async({page},info)=>{
  await page.setViewportSize({width,height:900});
  await page.addInitScript(({style,theme,mode})=>{localStorage.setItem('pawspace.visual-style',style);localStorage.setItem('pawspace.customer.theme',theme);localStorage.setItem('pawspace.customer.appearance',mode);localStorage.setItem('pawspace.cookie-consent','essential');},{style,theme,mode});
  const writes:string[]=[];let errorState=false;
  await page.route('**/api/**',async route=>{
   const req=route.request(),path=new URL(req.url()).pathname;
   if(req.method()!=='GET'){writes.push(`${req.method()} ${path}`);return route.fulfill({status:403,json:{error:'Writes denied in isolated onboarding audit'}});}
   if(path==='/api/identity-session')return route.fulfill({json:{data:{subjectType:'provider',subjectId:'UI-ONBOARDING-P'}}});
   if(path==='/api/provider-onboarding-self-service')return errorState?route.fulfill({status:503,json:{error:'Synthetic snapshot unavailable'}}):route.fulfill({json:{data:{applications:[{application:{id:'UI-ONBOARDING-A',status:'draft',quiz_status:'pending'},quiz:{id:'UI-QUIZ',questions:[{questionId:'UI-Q',prompt:'Fixture care question',options:[{value:'a',label:'Fixture answer A'},{value:'b',label:'Fixture answer B'}]}]}}]}}});
   return route.fulfill({status:404,json:{error:'Outside isolated fixture'}});
  });
  await page.goto('/partner/onboarding');await expect(page.getByRole('heading',{name:'Your PawSpace caregiver application',exact:true})).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-paw-style',style);await expect(page.locator('html')).toHaveAttribute('data-paw-theme',theme);await expect(page.locator('html')).toHaveAttribute('data-paw-mode',mode);
  const privacy=page.getByRole('button',{name:'Essential only',exact:true});if(await privacy.isVisible())await privacy.click();
  const back=page.getByRole('link',{name:'← Back to Careers',exact:true});
  const option=page.getByText('Fixture answer A',{exact:true});
  const submit=page.getByRole('button',{name:'Submit application',exact:true});
  const measurements={back:await measure(back),option:await measure(option),submit:await measure(submit)};
  if(!baseline){for(const m of Object.values(measurements)){expect(m.height).toBeGreaterThanOrEqual(44);expect(m.width).toBeGreaterThanOrEqual(44);expect(m.contrast).toBeGreaterThanOrEqual(4.5);}}
  await option.getByRole('radio').focus();await page.keyboard.press('Space');await expect(option.getByRole('radio')).toBeChecked();await expect(page.getByRole('button',{name:'Submit answers',exact:true})).toBeEnabled();
  if(!baseline)expect(await option.evaluate(e=>getComputedStyle(e).outlineStyle)).not.toBe('none');
  await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+2);
  await page.screenshot({path:info.outputPath(`qualification-${baseline?'baseline':'candidate'}-${head}.png`),fullPage:true,animations:'disabled'});
  errorState=true;await page.reload();const error=page.getByRole('alert').filter({hasText:'Synthetic snapshot unavailable'});await expect(error).toBeVisible();const errorMeasurement=await measure(error);if(!baseline)expect(errorMeasurement.contrast).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({path:info.outputPath(`error-${baseline?'baseline':'candidate'}-${head}.png`),fullPage:true,animations:'disabled'});
  await info.attach('measured-controls',{body:JSON.stringify({sourceHead:head,baseline,stylesheetSource:baseline?'11dbcc13a4f8696ad2db02e34784eb8c9f7e1197':head,width,style,theme,mode,measurements,error:errorMeasurement,writes}),contentType:'application/json'});
  expect(writes).toEqual([]);
 });
}
