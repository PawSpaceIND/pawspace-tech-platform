import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const adapterDelta=JSON.parse(readFileSync(new URL('../fixtures/next-audio-reviewed-adapter-delta.json',import.meta.url),'utf8'));
const guardImport='import { isNextAudioThread } from "./next-audio-budget";\n';
const guardContext='...(isNextAudioThread(input.threadId)?{nextAudioConversation:{threadId:input.threadId,customerId:input.customerId}}:{}),';
/** Reverse only the independently reviewed 8d26ab3 test-budget wiring. Historical hashes stay fixed. */
export function preservedNextAudioBytes(path,bytes){
 if(path==='.github/workflows/elevenlabs-provider-preflight.yml'){const source=bytes.toString(),marker='\n  next-bounded-audio:\n';assert.equal(source.split(marker).length,2,'Exactly one reviewed audio workflow job is required');const index=source.indexOf(marker);assert.equal(createHash('sha256').update(source.slice(index)).digest('hex'),'8e31f15564191c4ebb0389640e2465760d76cb31e952a7717089a4b0443abc1c','Audio workflow must retain exact reviewed bytes');return Buffer.from(source.slice(0,index));}
 if(path===adapterDelta.file){let s=bytes.toString();for(const [before,after] of adapterDelta.reversals){assert.equal(s.split(after).length,2,'Exactly one reviewed next-audio adapter change is required');s=s.replace(after,before);}return Buffer.from(s);}
 if(path!=='lib/ai-grounded-runtime-provider.ts')return bytes;
 let source=bytes.toString();
 for(const exact of [guardImport,guardContext]){
  assert.equal(source.split(exact).length,2,'Exactly one reviewed next-audio guard addition is required');
  source=source.replace(exact,'');
 }
 return Buffer.from(source);
}
