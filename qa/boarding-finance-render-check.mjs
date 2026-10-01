import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {chromium} from '@playwright/test';
import postcss from 'postcss';
import {installWorkersHooks} from '../tests/helpers/module-hooks.mjs';
installWorkersHooks('__BOARDING_FINANCE_RENDER__');
const {default:Workspace,BoardingFinanceBooking,BoardingFinanceQueue}=await import('../app/team/finance/boarding/boarding-finance-workspace.tsx');
const noAction=()=>{throw new Error('Static presentation preview cannot act');};
const data={bookingId:'UI-BOARDING-LONG-ID-ONLY',stay:{booking_status:'confirmed',stay_status:'completed',total_amount:1398,payment_status:'captured',package_name:'Two-pet prepaid stay',check_in_at:'2026-10-01',check_out_at:'2026-10-03',host_provider_id:'UI-HOST',city_id:'blr'},cancellations:[{id:'UI-CANCEL',status:'policy_review_required',reason:'Synthetic fixture only'}],refunds:[{id:'UI-REFUND',status:'sandbox_pending',amount:279.6}],changes:[{id:'UI-CHANGE',status:'commercial_quote_required',requested_start:'2026-10-05',requested_end:'2026-10-07'}],settlement:null,reconciliation:null};
const booking=renderToStaticMarkup(h(BoardingFinanceBooking,{data,busy:false,on:Object.fromEntries(['approveCancel','recordRefund','applyDateChange','issueInvoice','configureTax','prepareSettlement','reconcile'].map(k=>[k,noAction]))}));
const queue=renderToStaticMarkup(h(BoardingFinanceQueue,{queue:{items:[{booking_id:data.bookingId,package_name:'Two-pet prepaid stay',stay_status:'completed',payment_status:'captured',pending_refunds:1,pending_refund_amount:279.6}],limit:100},error:'',busy:false,onOpen:noAction}));
let body=renderToStaticMarkup(h(Workspace,{initialBookingId:data.bookingId}));
body=body.slice(body.indexOf('<main'),body.indexOf('</main>')+7).replace('</main>',booking+'</main>');
body=body.replace(/<section[^>]*><h2>Waiting on Finance<\/h2><p>Loading pending Boarding requests…<\/p><\/section>/,queue);
const paths=['app/pawspace-design-system.css','app/components/staff-workspace/staff-workspace.module.css','app/components/staff-workspace/staff-console.module.css','app/components/staff-workspace/staff-module.module.css','app/components/ui/ui.module.css'];
try{readFileSync(new URL('../app/team/finance/boarding/boarding-content.module.css',import.meta.url));paths.push('app/team/finance/boarding/boarding-content.module.css');}catch{}
const css=paths.map(p=>{const root=postcss.parse(readFileSync(new URL('../'+p,import.meta.url),'utf8'));root.walkAtRules('font-face',r=>r.remove());root.walkRules(r=>{r.selector=r.selector.replace(/:global\(([^)]+)\)/g,'$1');});return root.toString();}).join('\n');
const phase=process.argv.includes('--verify')?'after':'before',dir=new URL('../../ui-boarding-finance-qa/'+phase+'/',import.meta.url);mkdirSync(dir,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.PW_CHROMIUM_EXECUTABLE_PATH||'/Users/karthikeyanparamasivam/Library/Caches/ms-playwright/chromium_headless_shell-1194/chrome-mac/headless_shell'});const cases=[];
try{for(const width of [320,412,820,1440])for(const style of ['professional','cartoon']){
const page=await browser.newPage({viewport:{width,height:900}}),requests=[];await page.route('**/*',r=>{requests.push(r.request().url());return r.abort();});
await page.setContent(`<html data-paw-style="${style}" data-paw-theme="emerald" data-paw-mode="${style==='cartoon'?'dark':'light'}"><head><style>${css}\n*{box-sizing:border-box}body{margin:0}</style></head><body><div class="frame"><div class="console module">${body}</div></div></body></html>`);
const geometry=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,controls:[...document.querySelectorAll('main button,main input,main header a')].map(e=>({text:e.textContent||e.getAttribute('aria-label'),height:e.getBoundingClientRect().height,right:e.getBoundingClientRect().right,width:e.getBoundingClientRect().width}))}));
if(phase==='after'){assert.ok(geometry.scrollWidth<=width+1,JSON.stringify(geometry));for(const c of geometry.controls){assert.ok(c.height>=48-.1,JSON.stringify(c));assert.ok(c.right<=width+.1,JSON.stringify(c));}assert.deepEqual(requests,[]);}
const file=`boarding-${width}-${style}.png`;await page.screenshot({path:new URL(file,dir).pathname,fullPage:true});cases.push({width,style,file,geometry,requests});await page.close();
}writeFileSync(new URL('receipt.json',dir),JSON.stringify({scope:'Actual Boarding components SSR, isolated main; no hydration, full shell, authenticated role or finance action acceptance',phase,cases},null,2));console.log(JSON.stringify({phase,cases:cases.length,minHeight:Math.min(...cases.flatMap(c=>c.geometry.controls.map(x=>x.height))),overflow:cases.filter(c=>c.geometry.scrollWidth>c.width+1).map(c=>({width:c.width,style:c.style,scrollWidth:c.geometry.scrollWidth}))}));}finally{await browser.close();}
