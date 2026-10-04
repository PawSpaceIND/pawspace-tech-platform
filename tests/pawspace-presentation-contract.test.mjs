import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import {themes, resolveBrandTheme, resolveVisualStyle, DEFAULT_STYLE, isOfferedTheme, isLegacyThemeId} from '../app/mobile-app/theme-config.ts';
const root = new URL('../', import.meta.url);
const read=p=>fs.readFileSync(new URL(p,root),'utf8');
function files(dir){return fs.readdirSync(new URL(dir,root),{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(`${dir}/${e.name}`):[`${dir}/${e.name}`]);}
test('the shared layout offers Editorial and gates Concierge while preserving legacy metadata',()=>{
 assert.deepEqual(themes.map(t=>t.id),['editorial','concierge']);
 assert.equal(DEFAULT_STYLE,'professional');
 assert.equal(resolveVisualStyle('cartoon'),'cartoon');
 assert.equal(resolveVisualStyle(null),'professional');
 assert.equal(isLegacyThemeId('coral'),true);
 assert.equal(isOfferedTheme('concierge',false),false);
 assert.equal(isOfferedTheme('concierge',true),true);
 assert.equal(resolveBrandTheme('unknown',false),'editorial');
 assert.equal(resolveBrandTheme('concierge',false),'editorial');
 assert.equal(resolveBrandTheme('concierge',true),'concierge');
});
test('every shared palette reference resolves and legacy sheets cannot redefine the root palette',()=>{
 const sheet=read('app/pawspace-design-system.css');
 const definitions=new Set([...sheet.matchAll(/(--[\w-]+)\s*:/g)].map(m=>m[1]));
 for(const file of files('app').filter(f=>f.endsWith('.css'))){
  const tree=postcss.parse(read(file));
  tree.walkDecls(d=>{
   if(!file.endsWith('pawspace-design-system.css'))assert.ok(!d.prop.startsWith('--paw-'),`${file}: shadowed ${d.prop}`);
   for(const m of d.value.matchAll(/var\((--(?:ui-|paw-)[\w-]+)/g))assert.ok(definitions.has(m[1]),`${file}: undefined ${m[1]}`);
  });
 }
});
test('welcome is decorative and cannot intercept navigation, location or booking',()=>{
 const welcome=read('app/components/pawspace-welcome.tsx');
 assert.match(welcome,/aria-hidden="true"/);
 assert.doesNotMatch(welcome,/fetch\(|geolocation|localStorage|onClick|router|setTimeout/);
 const sheet=read('app/pawspace-design-system.css');
 assert.match(sheet,/pointer-events:none/);
 assert.match(sheet,/@media\(prefers-reduced-motion:reduce\)/);
 assert.match(sheet,/\.paw-welcome\{display:none\}/);
});

test('palette foreground roles maintain readable contrast in light and dark modes', async () => {
  const postcss = (await import('postcss')).default;
  const root = postcss.parse(fs.readFileSync(new URL('../app/pawspace-design-system.css', import.meta.url), 'utf8'));
  const luminance = hex => { const c = hex.replace('#','').match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4); return c[0]*0.2126+c[1]*0.7152+c[2]*0.0722; };
  const ratio = (a,b) => (Math.max(luminance(a),luminance(b))+0.05)/(Math.min(luminance(a),luminance(b))+0.05);
  for (const theme of ['emerald','signature','coral']) for (const mode of ['light','dark']) {
    const values = {};
    root.walkRules(rule => {
      const matches = rule.selector.split(',').some(selector => {
        selector=selector.trim();
        if (!/^(?:html|:root)/.test(selector) || /\s|\./.test(selector)) return false;
        const t=selector.match(/data-paw-theme="([^"]+)"/), m=selector.match(/data-paw-mode="([^"]+)"/);
        return (!t||t[1]===theme)&&(!m||m[1]===mode)&&!selector.includes('data-paw-style');
      });
      if(matches)rule.walkDecls(d=>{values[d.prop]=d.value});
    });
    const resolve = key => {const v=values[key];return v?.startsWith('var(')?resolve(v.slice(4,-1)):v;};
    for(const [foreground,background] of [['--paw-text','--paw-bg'],['--paw-text','--paw-surface'],['--paw-muted','--paw-surface'],['--paw-link','--paw-surface'],['--paw-link','--paw-raised'],['--paw-on-primary','--paw-primary'],['--paw-on-primary','--paw-deep'],['--ui-on-gold','--paw-gold'],['--paw-gold','--paw-deep'],['--ds-warning-600','--ds-warning-50'],['--ds-danger-600','--ds-danger-50'],['--ds-success-600','--ds-success-50']]) {
      assert.ok(ratio(resolve(foreground),resolve(background))>=4.5, `${theme}/${mode}: ${foreground} on ${background}`);
    }
  }
});

test('legacy booking widgets distinguish surface backgrounds from button foregrounds', () => {
  const source=read('app/pawspace-design-system.css');
  assert.match(source,/--ds-text:var\(--paw-text\)/);
  for(const file of ['app/walking/walking.module.css','app/mobile-app/address-picker.module.css']) {
    postcss.parse(read(file)).walkDecls(d=>{
      if(/^background(?:-color)?$/.test(d.prop)) assert.notEqual(d.value,'var(--ds-on-primary)',file);
    });
  }
});

test('the root appearance fixes one professional structure and exposes shared corner tokens',()=>{
 const sheet=read('app/pawspace-design-system.css');
 assert.match(read('app/layout.tsx'),/data-paw-style="professional"/);
 assert.match(sheet,/--paw-card-radius:16px/);
 assert.match(sheet,/--paw-control-radius:12px/);
 assert.match(sheet,/--v2-control-radius:var\(--paw-control-radius\)/);
});

test('every web module inherits the single root appearance controller',()=>{
 const layout=read('app/layout.tsx');
 assert.equal((layout.match(/<PawSpaceAppearance\b/g)||[]).length,1);
 assert.ok(layout.indexOf('./pawspace-design-system.css')>layout.indexOf('./brand-book-theme.css'));
 for(const file of files('app').filter(f=>f.endsWith('/layout.tsx')&&f!=='app/layout.tsx'))assert.doesNotMatch(read(file),/<html\b|<body\b|<PawSpaceAppearance\b/,file);
 assert.match(read('app/components/pawspace-appearance.tsx'),/window.addEventListener\("storage", sync\)/);
 assert.match(read('app/components/pawspace-appearance.tsx'),/window.addEventListener\("pawspace-appearance-change", sync\)/);
});

test('inline component corners cannot bypass the global Professional/Fun style',async()=>{
 const ts=(await import('typescript')).default;
 for(const file of files('app').filter(f=>f.endsWith('.tsx'))){
  const source=ts.createSourceFile(file,read(file),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  function visit(node){if(ts.isPropertyAssignment(node)&&node.name.getText(source)==='borderRadius'&&ts.isNumericLiteral(node.initializer)){const value=Number(node.initializer.text);assert.ok(value<8||value>32,`${file}: fixed inline radius ${value}`);}ts.forEachChild(node,visit);}visit(source);
 }
});

test('staff appearance uses the same saved choice and change event as the main selector',()=>{
 const staff=read('app/control/appearance-platform-panel.tsx');
 assert.match(staff,/localStorage\.getItem\(THEME_STORAGE_KEY\)/);
 assert.match(staff,/useState<ThemeId>\("editorial"\)/);
 assert.doesNotMatch(staff,/useState<ThemeId>\(readStoredTheme\)/);
 assert.match(staff,/localStorage\.setItem\(THEME_STORAGE_KEY, next\)/);
 assert.match(staff,/window\.addEventListener\("pawspace-appearance-change", sync\)/);
 assert.match(staff,/detail: \{ theme: next \}/);
});
