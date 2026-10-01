import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {readFileSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {chromium} from '@playwright/test';
import postcss from 'postcss';
import {installWorkersHooks} from '../tests/helpers/module-hooks.mjs';
installWorkersHooks('__TRAINING_FINANCE_RENDER__');
registerHooks({resolve(specifier,context,next){if(specifier==='../../../components/ui'&&context.parentURL?.includes('/finance/training/page.tsx'))return {url:new URL('../../../components/ui/index.ts',context.parentURL).href,shortCircuit:true};return next(specifier,context);}});
const {default:Training}=await import('../app/team/finance/training/page.tsx');
let body=renderToStaticMarkup(h(Training));body=body.slice(body.indexOf('<main'),body.indexOf('</main>')+7);
const paths=['app/pawspace-design-system.css','app/components/staff-workspace/staff-workspace.module.css','app/components/staff-workspace/staff-console.module.css','app/components/staff-workspace/staff-module.module.css','app/components/staff-workspace/visual-audit-closure.module.css','app/components/ui/ui.module.css'];
if(existsSync(new URL('../app/team/finance/training/training-content.module.css',import.meta.url)))paths.push('app/team/finance/training/training-content.module.css');
const css=paths.map(p=>{const root=postcss.parse(readFileSync(new URL('../'+p,import.meta.url),'utf8'));root.walkAtRules('font-face',r=>r.remove());root.walkRules(r=>{r.selector=r.selector.replace(/:global\(([^)]+)\)/g,'$1');});return root.toString();}).join('\n');
const phase=process.argv.includes('--verify')?'after':'before',dir=new URL('../../ui-training-finance-qa/'+phase+'/',import.meta.url);mkdirSync(dir,{recursive:true});const cases=[];
const browser=await chromium.launch({headless:true,executablePath:process.env.PW_CHROMIUM_EXECUTABLE_PATH||'/Users/karthikeyanparamasivam/Library/Caches/ms-playwright/chromium_headless_shell-1194/chrome-mac/headless_shell'});
try{for(const width of [320,412,820,1440])for(const style of ['professional','cartoon']){
 const page=await browser.newPage({viewport:{width,height:900}}),requests=[];await page.route('**/*',r=>{requests.push(r.request().url());return r.abort();});
 await page.setContent(`<html data-paw-style="${style}" data-paw-theme="emerald" data-paw-mode="${style==='cartoon'?'dark':'light'}"><head><style>${css}\n*{box-sizing:border-box}body{margin:0}</style></head><body><div class="frame scope"><div class="console module">${body}</div></div></body></html>`);
 const geometry=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,controls:[...document.querySelectorAll('main button,main header a')].map(e=>({text:e.textContent,height:e.getBoundingClientRect().height})),tables:[...document.querySelectorAll('main table')].map(e=>({wrapperTabIndex:e.parentElement.tabIndex,role:e.parentElement.getAttribute('role'),label:e.parentElement.getAttribute('aria-label'),scrollWidth:e.parentElement.scrollWidth,width:e.parentElement.clientWidth}))}));
 if(phase==='after'){assert.ok(geometry.scrollWidth<=width+1);for(const c of geometry.controls)assert.ok(c.height>=48-.1,JSON.stringify(c));assert.equal(geometry.tables.length,3);for(const t of geometry.tables){assert.equal(t.wrapperTabIndex,0);assert.equal(t.role,'region');assert.ok(t.label?.includes('scroll horizontally'));}for(const r of await page.getByRole('region').all()){await r.focus();assert.equal(await r.evaluate(e=>e===document.activeElement),true);assert.equal(await r.evaluate(e=>getComputedStyle(e).outlineOffset),'-3px');}assert.deepEqual(requests,[]);}
 await page.locator('h1').click();await page.evaluate(()=>scrollTo(0,0));const file=`training-${width}-${style}.png`;await page.screenshot({path:new URL(file,dir).pathname,fullPage:true});cases.push({width,style,file,geometry,requests});await page.close();
 }writeFileSync(new URL('receipt.json',dir),JSON.stringify({scope:'Actual initial Training Finance SSR; no loaded-row, hydration, full shell, real role or financial-action acceptance',phase,cases},null,2));console.log(JSON.stringify({phase,cases:cases.length,minHeight:Math.min(...cases.flatMap(c=>c.geometry.controls.map(x=>x.height))),tableFocusTargets:cases[0].geometry.tables.map(t=>t.wrapperTabIndex)}));}finally{await browser.close();}
