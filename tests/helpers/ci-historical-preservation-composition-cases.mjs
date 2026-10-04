import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
import {preservedCombinedLocalBytes,preservedServiceLintBytes} from './combined-local-reviewed-delta.mjs';
import {preservedServiceFixBytes} from './service-fix-reviewed-delta.mjs';
const combined=JSON.parse(readFileSync(new URL('../fixtures/combined-local-reviewed-delta.json',import.meta.url))),training=JSON.parse(readFileSync(new URL('../fixtures/training-integrated-reviewed-delta.json',import.meta.url))),service=JSON.parse(readFileSync(new URL('../fixtures/service-fix-reviewed-delta.json',import.meta.url))),hash=b=>createHash('sha256').update(b).digest('hex');
for(const path of ['app/api/ai-web-chat/route.ts','lib/ai-web-chat-adapter.ts','lib/api-gateway.ts','app/trainer/page.tsx','app/v2/grooming/page.tsx']){
 const bytes=readFileSync(new URL('../../'+path,import.meta.url));
 const restore=b=>path==='app/v2/grooming/page.tsx'?preservedServiceFixBytes(path,preservedServiceLintBytes(path,b)):preservedCombinedLocalBytes(path,b);
 test('Exact historical CI composition restores reviewed predecessor: '+path,()=>{const out=restore(bytes),expected=path==='app/v2/grooming/page.tsx'?service.files[path].originalHash:(combined.files[path]??training.files[path]).beforeSha256;assert.equal(hash(out),expected);});
 for(const [name,alter]of [['append',b=>b+'\nUNREVIEWED'],['change',b=>'X'+b.toString().slice(1)],['remove',b=>b.toString().slice(1)],['line endings',b=>b.toString().replaceAll('\n','\r\n')]])test('Historical CI composition rejects '+name+': '+path,()=>assert.throws(()=>restore(Buffer.from(alter(bytes)))));
}
