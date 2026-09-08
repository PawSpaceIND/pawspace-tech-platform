import test from 'node:test';
import assert from 'node:assert/strict';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__STAY_ENTRY_DB__');
for(const route of ['boarding','sitting'])test(`${route} entry waits for the owned account before exposing booking or sample care`,async()=>{const React=await import('react'),{renderToStaticMarkup}=await import('react-dom/server'),{default:Page}=await import(`../app/${route}/page.tsx`);const html=renderToStaticMarkup(React.createElement(Page));assert.match(html,/Loading your PawSpace account/);assert.match(html,route==='boarding'?/>Boarding<\//:/>Pet Sitting<\//);assert.doesNotMatch(html,/98802|TST-101|PawSpace UAT vet|Confirm booking|<textarea/);});
