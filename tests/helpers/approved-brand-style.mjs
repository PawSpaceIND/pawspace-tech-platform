import fs from 'node:fs';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import postcss from 'postcss';
const root=new URL('../../',import.meta.url),c=JSON.parse(fs.readFileSync(new URL('tests/fixtures/customer-partner-theme-contract.json',root),'utf8'));
const hash=v=>createHash('sha256').update(v).digest('hex');
/** Older snapshots still verify their exact bytes; only the explicitly approved CSS append is separated. */
export function preservedBrandStyleBytes(path){
 const bytes=fs.readFileSync(new URL(path,root)),approved=c.styles[path];if(!approved)return bytes;
 const source=bytes.toString(),at=source.indexOf('\n'+c.marker);assert.ok(at>=0,'Missing approved append marker: '+path);
 const original=source.slice(0,at);assert.equal(hash(original),approved.hash,'Original stylesheet edited: '+path);
 const appended=source.slice(at+1+c.marker.length),tree=postcss.parse(appended);
 tree.walkAtRules(rule=>assert.ok(['media','supports'].includes(rule.name),'Unexpected at-rule '+path+': '+rule.name));
 tree.walkRules(rule=>{assert.ok(approved.roots.some(name=>rule.selector.includes('.'+name)),'Unscoped appended rule: '+path+' '+rule.selector);assert.ok(!/(?:^|,)\s*(?:body|html|:root)\s*\{?/.test(rule.selector),'Document-wide override');});
 tree.walkDecls(d=>{assert.ok(!/expression\(|javascript:|https?:\/\//i.test(d.value),'External/active style value');if(d.prop==='composes')assert.match(d.value,/^palette from ["'][.\/]+.*brand-surface\.module\.css["']$/);});
 return Buffer.from(original);
}
