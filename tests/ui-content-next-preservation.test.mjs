import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__UI_CONTENT_NEXT__');
const {default:PartnerJobs}=await import('../app/partner/jobs/page.tsx');
test('Partner jobs renders its existing workspace destination and loading state without inventing jobs',()=>{
 const html=renderToStaticMarkup(createElement(PartnerJobs));
 assert.match(html,/href="\/partner\/workspace"/);
 assert.match(html,/>Your jobs<\/h1>/);
 assert.match(html,/Loading your jobs/);
 assert.doesNotMatch(html,/Accept job|Complete job/);
});
const baseline=JSON.parse(readFileSync(new URL('./fixtures/ui-content-next-preservation.json',import.meta.url),'utf8'));
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
for(const [path,hash] of Object.entries(baseline))test(`existing handlers, state and requests are preserved: ${path}`,()=>{
 let source=read(path);
 if(path.includes('/activity/'))source=source.replace('See upcoming care, check booking details and revisit past visits.','This view reads the same canonical PawSpace customer record used by checkout, partner operations and finance.').replace('Find your past visits, cancellations and refunds here.','Completed, cancelled and refunded bookings remain attached to your family record.');
 else source=source.replace('import styles from "../work-content.module.css";\n','').replace(/ className=\{styles\.(jobs|rates|jobCard|workspaceLink|jobSection|rateCard|status)\}/g,'');
 source=source.replace(' data-status={job.status}','');
 assert.equal(createHash('sha256').update(source).digest('hex'),hash);
});
test('responsive rate cards keep the existing number field and save authority',()=>{
 const source=read('app/partner/rates/page.tsx');
 assert.match(source,/className=\{styles.rateCard\}/);
 assert.match(source,/min=\{o.floorPrice\}/);
 assert.match(source,/disabled=\{busy===key\|\|Number\(value\)<o.floorPrice\}/);
 assert.match(read('app/partner/work-content.module.css'),/grid-template-columns:minmax\(0,1fr\) !important/);
});
test('care actions and forms gain reachable focus and touch treatment without hiding content',()=>{
 const customer=read('app/v2/customer-detail.module.css'),partner=read('app/partner/work-content.module.css');
 assert.match(customer,/\.page \.booking a \{[^}]*min-height:48px/);
 assert.match(partner,/\.jobs \.workspaceLink \{[^}]*min-height:48px/);
 assert.match(customer,/:focus-visible/);assert.match(partner,/:focus-visible/);
 assert.doesNotMatch(partner,/display:\s*none|visibility:\s*hidden|pointer-events:\s*none/);
});

// Execute the actual page, including its CSS-module hooks and existing empty state.
// SSR does not run useEffect, so this assertion neither loads nor saves provider rates.
const {default:PartnerRates}=await import('../app/partner/rates/page.tsx');
test('actual provider rates page renders its responsive root and reachable existing empty state',()=>{
 const html=renderToStaticMarkup(createElement(PartnerRates));
 assert.match(html,/<main class="rates"/);
 assert.match(html,/Set your Boarding &amp; Sitting rates/);
 assert.match(html,/href="\/partner-mobile"/);
 assert.ok(html.includes('No self-pricing packages are available for this provider.'));
 assert.ok(html.includes('Confirmed bookings keep the price quoted at booking time.'));
 assert.doesNotMatch(html,/<input|Save rate/);
});
