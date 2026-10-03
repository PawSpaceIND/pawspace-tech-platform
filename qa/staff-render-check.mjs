import {registerHooks} from 'node:module';
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {chromium} from '@playwright/test';
import postcss from 'postcss';
import {installWorkersHooks} from '../tests/helpers/module-hooks.mjs';
installWorkersHooks('__FINANCE_VISUAL__');
const {default:Operations}=await import('../app/team/operations/page.tsx');
// Resolve the actual UI barrel directory as the application bundler does; no component is stubbed.
registerHooks({resolve(specifier,context,nextResolve){
 if(specifier==='../../components/ui' && context.parentURL?.includes('/app/team/people/page.tsx'))return {url:new URL('../../components/ui/index.ts',context.parentURL).href,shortCircuit:true};
 return nextResolve(specifier,context);
}});
const {default:People}=await import('../app/team/people/page.tsx');
const css=paths=>paths.map(p=>{const root=postcss.parse(readFileSync(new URL('../'+p,import.meta.url),'utf8'));root.walkAtRules('font-face',r=>r.remove());root.walkAtRules('import',r=>r.remove());root.walkRules(r=>{r.selector=r.selector.replace(/:global\(([^)]+)\)/g,'$1');});return root.toString();}).join('\n');
const styles=css(['app/globals.css','app/pawspace-design-system.css','app/components/ui/ui.module.css','app/components/staff-workspace/staff-workspace.module.css','app/components/staff-workspace/staff-module.module.css','app/team/team-console.module.css','app/team/presentation-next/staff-content.module.css']);
const bodies=[['operations',renderToStaticMarkup(h(Operations))],['people',renderToStaticMarkup(h(People))]];
const dir=new URL('../../ui-staff-content-qa/',import.meta.url);mkdirSync(dir,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Users/karthikeyanparamasivam/Library/Caches/ms-playwright/chromium_headless_shell-1194/chrome-mac/headless_shell'});
const receipts=[];
try{for(const [i,width] of [320,412,820,1440].entries())for(const style of ['professional','cartoon'])for(const [screen,body] of bodies){
 const theme=['emerald','signature','coral'][i%3],mode=(i%2)?'dark':'light';
 const page=await browser.newPage({viewport:{width,height:900}});const requests=[];await page.route('**/*',r=>{requests.push(r.request().url());return r.abort();});
 await page.setContent(body);
 const content=await page.locator(".workspace").innerHTML();
 await page.setContent(`<html data-paw-theme="${theme}" data-paw-style="${style}" data-paw-mode="${mode}"><head><style>${styles}\n*{box-sizing:border-box}body{margin:0}.page{background:var(--staff-bg);color:var(--staff-text)}</style></head><body><div class="frame" style="display:block"><main style="padding:20px;min-width:0">${content}</main></div></body></html>`);
 const geometry=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,controls:[...document.querySelectorAll('.queue,.workspaces a,.search input')].map(e=>({height:e.getBoundingClientRect().height,width:e.getBoundingClientRect().width,text:e.textContent?.slice(0,35)}))}));
 assert.ok(geometry.scrollWidth<=width+1,JSON.stringify(geometry));for(const c of geometry.controls)assert.ok(c.height>=48-0.1,JSON.stringify(c));
 const contrasts=await page.evaluate(()=>[...document.querySelectorAll('.workspaces a')].map(e=>{
  const parse=c=>c.match(/[\d.]+/g).map(Number),fg=parse(getComputedStyle(e).color);let parent=e,bg;
  while(parent){const c=parse(getComputedStyle(parent).backgroundColor);if(c.length===3||c[3]>0.99){bg=c;break;}parent=parent.parentElement;}
  const lum=c=>c.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
  const a=lum(fg),b=lum(bg);return {text:e.textContent,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
 }));for(const c of contrasts)assert.ok(c.ratio>=4.5,JSON.stringify(c));
 if(screen==='operations')assert.equal(await page.locator('.queue').count(),5);
 else {assert.equal(await page.locator('.workspaces a').count(),10);await page.getByRole('textbox',{name:'Find someone'}).focus();assert.equal(await page.locator('.search input').evaluate(e=>e===document.activeElement),true);}
 await page.locator('h1').click();await page.evaluate(()=>scrollTo(0,0));
 const file=`staff-${screen}-${width}-${style}-${theme}-${mode}.png`;await page.screenshot({path:new URL(file,dir).pathname,fullPage:true});receipts.push({screen,width,style,theme,mode,file,geometry,contrasts,requests});assert.deepEqual(requests,[]);await page.close();
}writeFileSync(new URL('receipt.json',dir),JSON.stringify({scope:'Isolated actual Operations/People workspace content from SSR; full shell and hydrated directory not accepted',cases:receipts},null,2));console.log(`${receipts.length}/16 isolated rendered cases PASS`);}finally{await browser.close();}
