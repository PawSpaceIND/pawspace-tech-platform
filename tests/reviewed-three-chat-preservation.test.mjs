import {isSalesInformationQuestion} from '../lib/ai-sales-information.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {reverseReviewedThreeChat} from './helpers/atlas-handoff-deadline-review.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const read=p=>readFileSync(new URL('../'+p,import.meta.url));
// Baseline includes qualified module gateway repair from integration21760d93.
const baseline=[
 ["cd40f510f886b39ac00cefc14aebfffae6ec1f232851e3736e9eb8b2bcfedaf4", "app/api/ai-web-chat/route.ts"],
 ["4a0790f38ab9f35a7b6fd436b5bb2ffd2092efe090ef590cea3bac94d8612e29", "lib/ai-web-chat-adapter.ts"],
 ["59b0e3516406d01581311db3e3f7042b441e065d62d16fcddc6c6604b2abfa27", "lib/api-gateway.ts"]
];
test('reviewed three-chat preservation receipt remains exact',()=>assert.equal(hash(read('tests/fixtures/reviewed-three-chat-preservation.json')),'a2de2bc255ae14bf0198238660ea9c25184d6f20f79dae7a6d0eeb26f004cf10'));
for(const[expected,path]of baseline)test('chat reversal preserves unowned bytes and rejects a mutation: '+path,()=>{const source=read(path);assert.equal(hash(reverseReviewedThreeChat(source,path)),expected);const mutated=source.toString()+'\n// unrelated source mutation\n';assert.notEqual(hash(reverseReviewedThreeChat(mutated,path)),expected);});
const receipt=JSON.parse(read('tests/fixtures/reviewed-three-chat-preservation.json'));
for(const[path,entry]of Object.entries(receipt))for(const[index,[,after]]of entry.replacements.entries())test('reviewed anchor deletion or duplication is refused: '+path+' #'+index,()=>{const source=read(path).toString();assert.throws(()=>reverseReviewedThreeChat(source.replace(after,after.slice(1)),path));assert.throws(()=>reverseReviewedThreeChat(source+after,path));});
test('bounded first sales input is information-only while a booking instruction is refused',()=>{assert.equal(isSalesInformationQuestion('Which Grooming package includes bath and nail clipping for a Labrador, and what are the published prices? Please recommend the best fit.'),true);assert.equal(isSalesInformationQuestion('Which Grooming package includes bath and nail clipping? Confirm it now.'),false);});
