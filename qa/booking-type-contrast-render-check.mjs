import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {chromium} from '@playwright/test';
import postcss from 'postcss';
import {execFileSync} from 'node:child_process';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {installWorkersHooks} from '../tests/helpers/module-hooks.mjs';
installWorkersHooks('__BOOKING_TYPE_RENDER__');
const {default:StayFlow}=await import('../app/mobile-app/stay-flow.tsx');
const {default:TaxiFlow}=await import('../app/mobile-app/taxi-flow.tsx');
const root=new URL('../',import.meta.url),phase=process.argv.includes('--before')?'before':'after';
const dir=new URL(`../artifacts/booking-type-contrast/${phase}/`,import.meta.url);mkdirSync(dir,{recursive:true});
// Isolated presentation fixtures mirror the stage-one JSX, including a long pet name.
// No account, booking, message, or payment requests; this is not hydrated journey acceptance.
const pet=(taxi)=>`<button class="selected" aria-pressed="true"><i>🐕</i><span><b>Sir Bartholomew Wellington the Third</b><small>${taxi?'dog':'Golden retriever · Adult · 24 kg'}</small></span>${taxi?'':'<em>✓</em>'}</button><button><i>＋</i><span><b>Add another pet</b><small>Add or edit pets here</small></span></button>`;
const browser=await chromium.launch({headless:true,executablePath:process.env.PW_CHROMIUM_EXECUTABLE_PATH||'/Users/karthikeyanparamasivam/Library/Caches/ms-playwright/chromium_headless_shell-1194/chrome-mac/headless_shell'}),cases=[];
try{for(const flow of ['boarding','taxi']){
let paths=['app/pawspace-design-system.css',`app/mobile-app/${flow==='boarding'?'stay':'taxi'}-flow.module.css`];
if(flow==='taxi')paths.push('app/v2/taxi/boarding-taxi-experience.module.css');
const css=paths.map(p=>{const s=phase==='before'&&p.includes('mobile-app')?execFileSync('git',['show',`51644f05:${p}`],{cwd:root,encoding:'utf8'}):readFileSync(new URL(p,root),'utf8');const parsed=postcss.parse(s);parsed.walkRules(r=>r.selector=r.selector.replace(/:global\(([^)]+)\)/g,'$1'));return parsed.toString();}).join('\n');
const rendered=renderToStaticMarkup(h(flow==='boarding'?StayFlow:TaxiFlow,{mode:'boarding',routeScope:'v2',customer:{customerId:'UI-FIXTURE',customerName:'Fixture',phone:'0000000000'}}));
assert.ok(rendered.includes(flow==='boarding'?'petList':'petGrid'));
const actual=rendered.replace(/<p[^>]*>Loading (?:your )?pets…<\/p>/,pet(flow==='taxi'));
assert.ok(actual.includes('Sir Bartholomew'));
for(const width of [320,412,820,1440])for(const style of ['professional','cartoon'])for(const theme of ['emerald','signature','coral'])for(const mode of ['light','dark']){
const page=await browser.newPage({viewport:{width,height:1000}}),requests=[];await page.route('**/*',r=>{requests.push(r.request().url());return r.abort();});
await page.setContent(`<html data-paw-style="${style}" data-paw-theme="${theme}" data-paw-mode="${mode}"><head><style>${css} *{box-sizing:border-box}body{margin:0;padding:12px}fieldset{min-width:0}.frame{max-width:1180px;margin:auto}.ride{width:100%}</style></head><body><div data-pawspace-v2="true" class="frame">${flow==='taxi'?'<div class="ride">':''}${actual}${flow==='taxi'?'</div>':''}</div></body></html>`);
const evidence=await page.evaluate(flow=>{
const selector=flow==='taxi'?'.wrap small,.label,.formGrid label,.petGrid b,.check b':'.petList b,.petList small,.chips button,.sectionHead,.hint,.field';
const rgb=s=>s.match(/[\d.]+/g).slice(0,3).map(Number),lum=c=>c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
const items=[...document.querySelectorAll(selector)].map(e=>{const cs=getComputedStyle(e);let p=e,bg;while(p){const s=getComputedStyle(p);if(s.backgroundColor!=='rgba(0, 0, 0, 0)'&&s.backgroundColor!=='transparent'){bg=s.backgroundColor;break;}p=p.parentElement;}const a=lum(rgb(cs.color)),b=lum(rgb(bg||getComputedStyle(document.body).backgroundColor));return {text:e.textContent.trim(),font:cs.fontFamily,size:parseFloat(cs.fontSize),color:cs.color,background:bg,contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};});
const names=[...document.querySelectorAll(flow==='taxi'?'.petGrid b':'.petList b')].map(e=>({text:e.textContent,width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}));return {scrollWidth:document.documentElement.scrollWidth,items,names};},flow);
if(phase==='after'){assert.ok(evidence.scrollWidth<=width+1,JSON.stringify({flow,width,evidence}));for(const i of evidence.items){assert.ok(i.contrast>=4.5,JSON.stringify({flow,width,style,theme,mode,i}));assert.ok(i.size>=12,JSON.stringify(i));assert.ok(i.font.includes('Inter'),JSON.stringify(i));}assert.ok(evidence.names[0].width>=150,JSON.stringify(evidence.names));assert.ok(evidence.names[0].height<=96,JSON.stringify(evidence.names));assert.deepEqual(requests,[]);}
const file=`${flow}-${width}-${style}-${theme}-${mode}.png`;if(theme==='emerald'&&mode==='light')await page.screenshot({path:new URL(file,dir).pathname,fullPage:true});cases.push({flow,width,style,theme,mode,evidence,requests});await page.close();
}
}
writeFileSync(new URL('receipt.json',dir),JSON.stringify({phase,scope:'Actual StayFlow/TaxiFlow SSR with synthetic pet rows replacing loading indicator; isolated shared tokens and flow CSS; no hydration/account/full-shell acceptance',cases},null,2));console.log(JSON.stringify({phase,cases:cases.length,minContrast:Math.min(...cases.flatMap(c=>c.evidence.items.map(i=>i.contrast))),minFontSize:Math.min(...cases.flatMap(c=>c.evidence.items.map(i=>i.size)))}));
}finally{await browser.close();}
