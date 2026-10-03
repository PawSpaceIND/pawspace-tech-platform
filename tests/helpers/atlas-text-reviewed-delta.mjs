import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root=new URL('../../',import.meta.url);
const reviewed=JSON.parse(readFileSync(new URL('../fixtures/atlas-text-reviewed-delta.json',import.meta.url),'utf8'));
/** Reverse only unique exact reviewed Atlas additions, before historical audio normalization. */
export function preservedAtlasTextBytes(path,bytes,read=p=>readFileSync(new URL(p,root))){
 const reversals=reviewed.reversals[path];if(!reversals)return bytes;
 for(const[p,hash]of Object.entries(reviewed.approvedSources))assert.equal(createHash('sha256').update(read(p)).digest('hex'),hash,'Reviewed Atlas admission changed: '+p);
 let source=bytes.toString();
 for(const[before,after]of reversals){assert.equal(source.split(after).length,2,'Exactly one reviewed Atlas addition required: '+path);source=source.replace(after,before);}
 return Buffer.from(source);
}
