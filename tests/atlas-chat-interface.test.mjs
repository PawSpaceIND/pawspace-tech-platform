import 'react';
import 'react/jsx-runtime';
import test from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__ATLAS_CHAT_UI_DB__');
const {AtlasChat}=await import('../app/team/ai/atlas-chat.tsx');
test('Atlas question interface starts with no invented response and disables submission while loading history',()=>{
 const html=renderToStaticMarkup(createElement(AtlasChat));
 assert.match(html,/Question for Atlas/);assert.match(html,/Loading Atlas history/);
 assert.match(html,/<button disabled="">Ask Atlas<\/button>/);
 assert.match(html,/does not approve or execute an action/);
 assert.doesNotMatch(html,/Model response received/);
});
