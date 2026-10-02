import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__TRAINING_FAMILY_PRESENTATION__');
const {groupTrainingPlans,TRAINING_FAMILIES}=await import('../app/training/training-family-map.ts');
const {default:Choices}=await import('../app/training/training-family-choices.tsx');
const codes=['trainer-meet-greet','training-2-starter','training-4-puppy','training-8-basic','training-8-leash','training-12-leash','training-12-advanced','training-16-pro','future-programme','future-assessment'];
const plans=Object.freeze(codes.map((package_code,i)=>Object.freeze({package_code,name:`Dynamic plan ${i}`,sessions:i+3,base_price:1234+i*37,validity_days:17+i,meet_and_greet:i===0||i===9?1:0})));
test('all canonical and unknown programmes survive grouping exactly once with original record identity',()=>{
 const grouped=groupTrainingPlans(plans),all=[...grouped.meet,...grouped.families.flatMap(x=>x.plans),...grouped.other];
 assert.equal(all.length,plans.length);assert.deepEqual(all.map(x=>x.package_code).sort(),[...codes].sort());
 for(const plan of all)assert.equal(plan,plans.find(x=>x.package_code===plan.package_code));
 assert.deepEqual(grouped.other.map(x=>x.package_code),['future-programme']);
 assert.deepEqual(grouped.meet.map(x=>x.package_code),['trainer-meet-greet','future-assessment']);
 assert.deepEqual(grouped.families.find(x=>x.id==='behavioral').plans.map(x=>x.package_code),['training-2-starter']);
 assert.deepEqual(grouped.families.find(x=>x.id==='obedience').plans.map(x=>x.package_code),['training-8-basic','training-12-advanced','training-16-pro']);
 assert.equal(TRAINING_FAMILIES.length,4);
 assert.deepEqual(groupTrainingPlans([]).families.map(x=>x.plans.length),[0,0,0,0]);
});
test('actual rendered groups retain every dynamic choice and expose selected/assessment/unknown options',()=>{
 for(const selectedCode of codes) {
  const html=renderToStaticMarkup(createElement(Choices,{plans,selectedCode,renderChoice:plan=>createElement('button',{'data-code':plan.package_code,key:plan.package_code},`${plan.name}|${plan.sessions}|${plan.base_price}|${plan.validity_days}`)}));
  assert.equal((html.match(/data-code=/g)||[]).length,plans.length);
  for(const plan of plans){assert.ok(html.includes(`data-code="${plan.package_code}"`));assert.ok(html.includes(`${plan.name}|${plan.sessions}|${plan.base_price}|${plan.validity_days}`));}
  assert.match(html,/Assessment-led · starts with an assessment/);assert.match(html,/Trainer introductions/);assert.match(html,/Other available programmes/);
  assert.ok(html.includes('Selected programme: <strong>'+plans.find(x=>x.package_code===selectedCode).name+'</strong>'));
  if(selectedCode!=='trainer-meet-greet'&&selectedCode!=='future-assessment')assert.match(html,/<details[^>]*open=""/);
 }
});
function preserveTrainingSource(input){
 let source=input;
 // Approved V2 default and presentation inputs only. No handler/guard is excluded.
 const cadence='[cadenceDays,setCadenceDays]=useState(routeScope==="v2"?3:7)';
 assert.equal(source.split(cadence).length,2);source=source.replace(cadence,'[cadenceDays,setCadenceDays]=useState(7)');
 const props='selectedCode={packageCode} recommendation={recommendation} petCount={petCount}';
 assert.equal(source.split(props).length,2);source=source.replace(props,'selectedCode={packageCode}');
 const readiness=JSON.parse(readFileSync(new URL('./helpers/schedule-readiness-edits.json',import.meta.url),'utf8'))['app/training/page.tsx'];
 for(const [before,after] of readiness){assert.equal(source.split(after).length,2);source=source.replace(after,before);}
 source=source.replace('\nimport TrainingFamilyChoices from "./training-family-choices";','');
 const start=source.indexOf('<>{Boolean(routeScope==="v2")?<TrainingFamilyChoices plans=');assert.ok(start>0);
 const fallback=source.indexOf(':<div className={styles.grid2}>{packages.map(item=>',start);assert.ok(fallback>start);
 const end=source.indexOf('</button>)}</div>}</>',fallback)+ '</button>)}</div>}</>'.length;assert.ok(end>fallback);
 const old=source.slice(fallback+1,end-4);
 const originalCallback=old.slice('<div className={styles.grid2}>{packages.map(item=>'.length,-')}</div>'.length);
 assert.equal(source.slice(start,fallback),'<>{Boolean(routeScope==="v2")?<TrainingFamilyChoices plans={packages} selectedCode={packageCode} renderChoice={item=>'+originalCallback+'}/>');
 source=source.slice(0,start)+old+source.slice(end);
 assert.equal(createHash('sha256').update(source).digest('hex'),'ca8cf10458d271d9ad781a9233ab2ed8fac6ed77a3e94732c183cba29945f30a');
 return source;
}
const pageSource=()=>readFileSync(new URL('../app/training/page.tsx',import.meta.url),'utf8');
test('page retains all original handlers, values, requests and V1 bytes after reversing its presentation wrapper',()=>{preserveTrainingSource(pageSource());});

import {uiWiringContract} from './helpers/ui-wiring-contract.mjs';
test('reviewed grouping/readiness changes normalize to the original interaction snapshot',()=>{
 const page=pageSource(), original=preserveTrainingSource(page);
 const baseline={sha256:'67e4443015c556f32793009f3776df305686f7955d556139cac67989c1dcf447',functions:86,declarations:99,interactionProps:51,conditions:34};
 assert.deepEqual(uiWiringContract(original,'app/training/page.tsx'),baseline);
 const actual=uiWiringContract(page,'app/training/page.tsx');
 assert.equal(actual.functions,baseline.functions+1);assert.equal(actual.interactionProps,baseline.interactionProps+3);
 assert.equal(actual.declarations,baseline.declarations);assert.equal(actual.conditions,baseline.conditions);
});
test('preservation rejects changed selection, guard, request, commercial expression and grouping inputs',()=>{
 const source=pageSource();
 const changes=[
 ['setPackageCode(item.package_code)','setPackageCode("different-plan")'],
 ['useState(routeScope==="v2"?3:7)','useState(routeScope==="v2"?5:7)'],
 ['recommendation={recommendation}','recommendation={null}'],
 ['petCount={petCount}','petCount={1}'],
 ['disabled={busy}','disabled={false}'],
 ['selectedCode={packageCode}','selectedCode={"different-plan"}'],
 ['plans={packages}','plans={packages.slice(1)}'],
 ['trainingPriceForPets(item.base_price,Math.max(1,petCount),item.extra_pet_percent)','trainingPriceForPets(item.base_price,1,item.extra_pet_percent)'],
 ['disabled={!location||petCount===0||busy||availabilityLoading}','disabled={false}'],
 ];
 for(const [before,after] of changes){assert.ok(source.includes(before),before);assert.throws(()=>preserveTrainingSource(source.replaceAll(before,after)),before);}
 const request=source.match(/fetch\("[^"]+/);assert.ok(request);assert.throws(()=>preserveTrainingSource(source.replace(request[0],'fetch("/api/changed-business-request')));
});
