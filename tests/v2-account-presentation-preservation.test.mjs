import {preservedAcceptedUiBytes} from './helpers/accepted-ui-reviewed-delta.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import postcss from 'postcss';
const read = path => readFileSync(new URL('../'+path,import.meta.url),'utf8');
test('Account presentation preserves every original byte except reviewed copy and CSS hooks',()=>{
 let source=preservedAcceptedUiBytes('app/v2/account/page.tsx',read('app/v2/account/page.tsx'));
 source=source.replace('\nimport accountStyles from "./account.module.css";','');
 for(const [oldText,newText] of [
  ['Family details without leaving V2.','Your pet family, all in one place.'],
  ['Profile, pets and addresses stay on the same canonical customer record used by every PawSpace service.','Keep your profile, pets and saved addresses together for your PawSpace bookings.'],
  ['Use secure OTP sign-in from the V2 home.','Sign in from home with a one-time code to view your profile, pets and saved addresses.'],
 ]) { assert.equal(source.split(newText).length-1,1);source=source.replace(newText,oldText); }
 source=source.replaceAll('className={`${styles.back} ${accountStyles.utility}`}','className={styles.back}')
  .replaceAll('className={`${styles.primary} ${accountStyles.utility}`}','className={styles.primary}')
  .replaceAll('className={`${styles.card} ${accountStyles.signedOut}`}','className={styles.card}')
  .replaceAll('className={`${styles.back} ${accountStyles.signIn}`}','className={styles.back}');
 assert.equal(createHash('sha256').update(source).digest('hex'),'d5ac65e4623140daa82ae60a1e1e4f084f46e471892e8f26fe36eb29b23b95f3');
});
test('Account stylesheet remains confined to three presentation hooks',()=>{
 const css=postcss.parse(read('app/v2/account/account.module.css'));
 css.walkRules(rule=>{ for(const selector of rule.selectors)assert.match(selector,/^\.(utility|signIn|signedOut)(?:\b|:)/); });
 css.walkDecls(decl=>{assert.doesNotMatch(decl.value,/url\(|expression\(|javascript:/i);assert.notEqual(decl.prop,'position');});
});
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__ACCOUNT_PRESENTATION_RENDER__');
const {default:AccountPage}=await import('../app/v2/account/page.tsx');
test('actual Account component renders the plain-language heading and existing appearance opener',()=>{
 const html=renderToStaticMarkup(createElement(AccountPage));
 assert.ok(html.includes('Your pet family, all in one place.'));
 assert.ok(html.includes('Keep your profile, pets and saved addresses together for your PawSpace bookings.'));
 assert.match(html,/Appearance &amp; display/);
 assert.match(read('app/v2/account/page.tsx'),/onClick=\{\(\)=>window\.dispatchEvent\(new CustomEvent\("pawspace-open-appearance"\)\)\}/);
 assert.match(html,/href="\/v2"/);
 assert.doesNotMatch(html,/canonical customer record|Family details without leaving V2/);
});
