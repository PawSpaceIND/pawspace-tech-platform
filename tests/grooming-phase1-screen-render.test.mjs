import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
installWorkersHooks("__PHASE1_RENDER_DB__");
const React=await import("react");
const {renderToStaticMarkup}=await import("react-dom/server");
const {default:GroomingFlow}=await import("../app/mobile-app/grooming-flow.tsx");
const {default:Home}=await import("../app/page.tsx");

for(const type of ["cat","kitten"])test(`${type} package screen does not offer or advertise canine tick treatment`,()=>{
  const html=renderToStaticMarkup(React.createElement(GroomingFlow,{customer:null,initial:{type,packId:"complete"}}));
  assert.doesNotMatch(html,/Tick &amp; flea/i);
  assert.match(html,/Full-body oil massage/);
});
test("dog package screen retains the eligible tick treatment",()=>{
  const html=renderToStaticMarkup(React.createElement(GroomingFlow,{customer:null,initial:{type:"dog"}}));
  assert.match(html,/Tick &amp; flea treatment/);
});
test("public service screen disables today's already-started slots at render time",t=>{
  t.mock.method(Date,"now",()=>Date.parse("2026-09-14T12:00:00+05:30"));
  const html=renderToStaticMarkup(React.createElement(Home));
  const slots=html.match(/<div class="slots-grid">(.*?)<\/div>/)?.[1];
  assert.ok(slots);
  const buttons=[...slots.matchAll(/<button([^>]*)>(.*?)<\/button>/g)];
  assert.equal(buttons.length,5);
  assert.match(buttons[0][1],/disabled/);
  assert.match(buttons[1][1],/disabled/);
  assert.doesNotMatch(buttons[2][1],/disabled/);
  assert.doesNotMatch(buttons[3][1],/disabled/);
  assert.doesNotMatch(buttons[4][1],/disabled/);
});
