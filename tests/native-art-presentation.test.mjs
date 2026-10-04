import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { installWorkersHooks } from './helpers/module-hooks.mjs';
// Executes the real art components and the home and Grooming pages (server render) through the shared hook.
installWorkersHooks('__NATIVE_ART_PRESENTATION_DB__');
const { NativeHero, NativeServiceArt } = await import('../app/components/native-art.tsx');
const { AppearanceProvider } = await import('../app/components/appearance-context.tsx');
const { resolveAppearance } = await import('../app/components/appearance-resolver.ts');
const root = new URL('../', import.meta.url);
const read = p => fs.readFileSync(new URL(p, root), 'utf8');
const manifest = JSON.parse(read('public/assets/native/asset-manifest.json'));
const withTheme = (theme, element) => renderToStaticMarkup(createElement(AppearanceProvider, { initial: { ...resolveAppearance({ cookieValue: `v1.${theme}.editorial.light.-`, conciergeAvailable: true }) } }, element));

test('hero renders only the effective theme sources, both pets described, no second hidden tree', () => {
  for (const theme of ['editorial', 'concierge']) {
    const html = withTheme(theme, createElement(NativeHero));
    const other = theme === 'editorial' ? 'concierge' : 'editorial';
    assert.doesNotMatch(html, new RegExp(`/assets/native/${other}/`), 'no other-theme asset');
    for (const w of [640, 960, 1536]) assert.match(html, new RegExp(`/assets/native/${theme}/hero-${w}\\.webp ${w}w`));
    assert.match(html, new RegExp(`src="/assets/native/${theme}/hero-fallback\\.jpg"`));
    assert.match(html, /width="1536" height="1024"/, 'dimensions reserved for the 3:2 frame');
    assert.match(html, /alt="Illustrative scene of a golden retriever and a Persian cat/);
    assert.equal((html.match(/<img /g) || []).length, 1);
    for (const file of ['hero-640.webp', 'hero-960.webp', 'hero-1536.webp', 'hero-fallback.jpg']) {
      const entry = manifest.assets.find(a => a.path === `assets/${theme}/${file}`);
      assert.ok(entry, file);
      assert.ok(fs.existsSync(new URL(`public/assets/native/${theme}/${file}`, root)));
    }
  }
});

test('service scenes use the manifest sprite coordinates, lazy loading and decorative alt by default', () => {
  const order = ['grooming', 'boarding', 'dog_training', 'pet_sitting', 'dog_walking', 'food', 'pet_taxi', 'relocation', 'family'];
  const names = ['Grooming', 'Boarding', 'Training', 'Pet Sitting', 'Dog Walking', 'Fresh Food', 'Pet Taxi', 'Relocation', 'Pet parents and their pets'];
  for (const theme of ['editorial', 'concierge']) {
    order.forEach((service, index) => {
      const sprite = manifest.service_sprites.find(s => s.theme === theme && s.service === names[index]);
      assert.ok(sprite, `${theme} ${service}`);
      const html = withTheme(theme, createElement(NativeServiceArt, { service }));
      assert.match(html, new RegExp(`--sprite-width:${sprite.img_width_percent}%`));
      assert.match(html, new RegExp(`--sprite-left:${sprite.img_left_percent}%`));
      assert.match(html, new RegExp(`--sprite-top:${sprite.img_top_percent}%`));
      assert.match(html, /class="ps-service-art"/);
      assert.match(html, /loading="lazy"/);
      assert.match(html, /alt=""/, 'decorative beside a visible label');
      assert.match(html, new RegExp(`/assets/native/${theme}/service-sheet-642\\.webp`));
      assert.doesNotMatch(html, /assigned|your groomer|staff/i, 'illustrative people are never presented as staff');
    });
    const informative = withTheme(theme, createElement(NativeServiceArt, { service: 'grooming', informative: true }));
    assert.match(informative, /alt="Illustrative grooming scene with a dog and a carer"/);
  }
});

test('home and Grooming pages no longer reference placeholder artwork and keep their contracts', () => {
  const home = read('app/v2/page.tsx'), grooming = read('app/v2/grooming/page.tsx');
  for (const source of [home, grooming]) {
    // Rendered art slots use the approved components; the SERVICES data keeps its legacy image field untouched (not rendered).
    assert.doesNotMatch(source, /<img src="\/assets\/pawspace-grooming-editorial\.webp"|<img src="\/assets\/pawspace-[a-z-]+-cartoon\.webp"|<img src=\{service\.image\}/, 'placeholder art removed from the page markup');
    assert.doesNotMatch(source, /4\.9|customer love|care experiences|family record/, 'no invented trust figures');
  }
  assert.match(home, /<NativeHero \/>/);
  assert.match(home, /Their happy place\.<br \/><em>Your peace of mind\.<\/em>/);
  assert.match(home, /href="#services" className=\{styles\.primaryAction\}>Explore care/);
  for (const href of ['/v2/grooming', '/v2/boarding', '/v2/training', '/v2/sitting', '/v2/walking', '/v2/food', '/v2/relocation', '/v2/taxi']) assert.ok(home.includes(`href: "${href}"`), href);
  assert.match(grooming, /<NativeServiceArt service="grooming" informative \/>/);
  assert.match(grooming, /Nothing reserved yet\./);
  assert.match(grooming, /Next · review payment/);
  for (const name of ['beginSecureCheckout', 'checkLiveCare', 'verifyCoverage', 'invalidateCare', 'invalidateDoorstep', 'togglePet', 'navigateToStep', 'coverageVersion', 'careVersion', 'checkoutLock']) assert.ok(grooming.includes(name), name);
});

test('appended layout rules stay scoped, visible-art and 48 px actions, with the approved service order', () => {
  const homeCss = read('app/v2/v2.module.css'), groomingCss = read('app/v2/grooming/grooming.module.css');
  const appended = homeCss.split('Approved shared layout (native A/C handoff')[1];
  assert.ok(appended, 'home append present');
  assert.match(appended, /:global\(html\[data-paw-theme\]\) \.page\.page\[data-v2-home\] \.serviceArt[^{]*\{ display:block/);
  assert.match(appended, /\.petPortrait \{ width:100%; max-width:none; aspect-ratio:3 \/ 2/);
  assert.match(appended, /\[data-home-care-tile="relocation"\] \{ order:1; \}/);
  assert.match(appended, /\[data-home-care-tile="funeral_memorial"\] \{ background:var\(--paw-surface\) !important/);
  assert.match(appended, /min-height:var\(--ps-button-min\)/);
  assert.match(appended, /outline:3px solid var\(--paw-focus-ring\) !important/);
  assert.doesNotMatch(appended, /url\(|https?:\/\//);
  const groomingAppend = groomingCss.split('Approved shared layout (native A/C handoff')[1];
  assert.match(groomingAppend, /:global\(html\[data-paw-theme\]\) \.page\.page \.heroArt \{ display:block/);
  assert.match(groomingAppend, /\.page\.page \.continue \{ background:var\(--brand-primary\) !important; color:var\(--brand-on-primary\) !important/);
  assert.match(groomingAppend, /border-color:var\(--paw-control-line\) !important; min-height:var\(--ps-input-min\)/);
  // The summary declarations the theme contract requires remain in place.
  assert.match(groomingCss, /\.page \.summary, \.loading \.summary, \.errorPage \.summary \{ background:var\(--brand-primary\) !important/);
});

test('Stage 3A: training and chat use the approved scenes and the shared sheet carries the layout rules', () => {
  const training = read('app/v2/training/page.tsx'), chat = read('app/v2/chat/page.tsx'), wati = read('app/components/wati-chat/WatiConversation.tsx');
  // Rendered art is a scene component; the legacy files are no longer rendered on these pages (chat keeps its map only for the services-card layout decision).
  assert.match(training, /<NativeServiceArt service="dog_training" informative className=\{styles\.heroScene\}\/>/);
  assert.doesNotMatch(training, /<Image |next\/image/);
  assert.match(chat, /const SERVICE_SCENE:Record<string,ServiceSceneCode>=\{grooming:"grooming",training:"dog_training",boarding:"boarding",pet_sitting:"pet_sitting",dog_walking:"dog_walking",pet_taxi:"pet_taxi",fresh_food:"food",relocation:"relocation"\}/);
  assert.match(chat, /serviceScene=\{SERVICE_SCENE\}/);
  assert.match(wati, /<span className=\{styles\.choiceArt\}><NativeServiceArt service=\{props\.serviceScene\[choice\.id\]\}\/><\/span>/);
  assert.match(wati, /:<img className=\{styles\.choiceArt\} src=\{props\.serviceArt\[choice\.id\]\} alt=""\/>/, 'unchanged fallback for callers without a scene map');
  // Every scene code the chat map uses exists in the component's scene index.
  for (const code of ['grooming', 'dog_training', 'boarding', 'pet_sitting', 'dog_walking', 'pet_taxi', 'food', 'relocation']) assert.match(read('app/components/native-art.tsx'), new RegExp(`\\b${code}: \\d`));
  // Shared sheet: theme control radius on the V2 canvas, primary edge on primary actions, display headings on customer, partner and staff roots.
  const css = read('app/pawspace-design-system.css');
  assert.match(css, /html\[data-paw-theme\] \.ps-service-art\{display:block!important;position:relative!important;overflow:hidden!important;aspect-ratio:1\/1!important;height:100%;width:auto;max-width:100%;margin:0 auto\}/, 'the sprite frame is always square: percent offsets are relative to the frame');
  assert.match(css, /html\[data-paw-theme\] \.ps-service-art>img\{position:absolute!important;width:var\(--sprite-width\)!important/, 'sprite geometry outranks module img rules');
  assert.match(css, /html\[data-paw-theme\] \[data-pawspace-v2\]\{--v2-control-radius:var\(--paw-control-radius\)\}/);
  assert.match(css, /html\[data-paw-theme\] \[data-pawspace-v2\] :is\(\[data-v2-action\],\[data-paw-action="primary"\]\)\{border:2px solid var\(--paw-primary-edge\)!important\}/);
  assert.match(css, /:is\(\[data-pawspace-v2\],\[data-partner-presentation\],\[data-staff-module\]\) :is\(h1,h2\)\{font-family:var\(--paw-display-font\)!important;font-weight:var\(--paw-display-weight\)!important\}/);
  const account = read('app/v2/account/page.tsx');
  assert.match(account, /Editorial Sanctuary is the shared PawSpace appearance; Modern Concierge arrives after validation/);
  assert.match(account, /onClick=\{\(\)=>window\.dispatchEvent\(new CustomEvent\("pawspace-open-appearance"\)\)\}>Appearance &amp; display<\/button>/);
  assert.doesNotMatch(account, /Professional or Fun|Choose style/);
  // Appended stylesheets stay after their approved marker and carry no URL.
  for (const file of ['app/v2/training/training-discovery.module.css']) {
    const sheet = read(file); const after = sheet.split('/* PAWSPACE CUSTOMER/PARTNER THEME: approved presentation-only append. */').slice(1).join('');
    assert.ok(after.length > 0, file); assert.doesNotMatch(after, /url\(|https?:\/\//); assert.match(after, /--sprite-width/);
  }
});

test('Stage 3B: Stay and Food heroes use the approved scenes; the Food team photo is gone; appends stay after their markers', () => {
  const stay = read('app/v2/stay-experience.tsx'), food = read('app/v2/food-experience.tsx');
  assert.match(stay, /<div className=\{styles\.art\}><NativeServiceArt service=\{mode==="boarding"\?"boarding":"pet_sitting"\} informative className=\{styles\.heroScene\}\/><\/div>/);
  assert.doesNotMatch(stay, /<Image |next\/image/);
  assert.match(stay, /import StayFlow from "\.\.\/mobile-app\/stay-flow";/, 'the workbook lane flow is still the booking surface');
  assert.match(food, /<NativeServiceArt service="food" informative className=\{styles\.heroScene\}\/><span>Illustrative PawSpace artwork<\/span>/);
  assert.doesNotMatch(food, /<Image |next\/image|SERVICE_ART|german-shepherd-hero|familyPhoto/, 'no legacy hero or overlapping team-member photo');
  assert.match(food, /UAT catalogue · no live charges/, 'the sandbox badge stays');
  for (const [file, marker] of [['app/v2/stay-experience.module.css', '/* PAWSPACE STAGE 3B: approved presentation-only append (Stay hero scene). */'], ['app/v2/food-experience.module.css', '/* PAWSPACE STAGE 3B: approved presentation-only append (Food hero scene). */']]) {
    const sheet = read(file); const parts = sheet.split(marker); assert.equal(parts.length, 2, `${file}: one Stage 3B marker`);
    assert.doesNotMatch(parts[1], /url\(|https?:\/\//); assert.match(parts[1], /\.heroScene \{ width:[^}]*aspect-ratio:1 \/ 1/);
  }
});

test('Stage 3C: the home entrance shows the approved family scene, keeps the official lockup, timing and reduced-motion rules, and no legacy photo', () => {
  const welcome = read('app/components/pawspace-welcome.tsx'), css = read('app/pawspace-design-system.css');
  assert.match(welcome, /<div className="paw-welcome-pets"><NativeServiceArt service="family" \/><\/div>/);
  assert.match(welcome, /<img className="paw-welcome-logo" src="\/assets\/pawspace-official-lockup\.png" alt="" \/>/, 'official lockup unchanged');
  assert.doesNotMatch(welcome, /breeds\/|\.jpg"|setTimeout|onClick/);
  assert.match(welcome, /aria-hidden="true"/);
  assert.match(css, /\.paw-welcome\{position:fixed;inset:0;z-index:200;[^}]*animation:paw-welcome-out 1\.65s both\}/, 'entrance timing unchanged');
  assert.match(css, /\.paw-welcome-pets \.ps-service-art\{width:160px;height:160px;[^}]*animation:paw-pet-in \.65s both\}/);
  assert.doesNotMatch(css, /\.paw-welcome-pets img/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[^}]*\.paw-welcome\{display:none\}/, 'reduced motion still hides the entrance');
});

test('Stage 3C: the Food phone append keeps the price review and the appearance control in flow, after the marker, with no URL', () => {
  const sheet = read('app/v2/food-experience.module.css'); const parts = sheet.split('/* PAWSPACE STAGE 3C: approved presentation-only append (Food mobile flow).');
  assert.equal(parts.length, 2, 'one Stage 3C Food marker'); const after = parts[1];
  assert.match(after, /@media\(max-width:760px\) \{ :global\(html\[data-paw-theme\]\) \.footer \{ position:static; bottom:auto; box-shadow:none; \} \}/);
  assert.match(after, /@media\(max-width:760px\) \{ :global\(body\):has\(\.page\) :global\(\.paw-appearance-trigger\) \{ position:relative !important; inset:auto !important; transform:none !important; width:fit-content; min-width:44px; min-height:44px;/);
  assert.doesNotMatch(after, /url\(|https?:\/\/|display:none|pointer-events|visibility:hidden/);
  assert.match(sheet, /\.footer\{position:sticky;bottom:12px;z-index:5;/, 'the desktop sticky price review is unchanged');
});
