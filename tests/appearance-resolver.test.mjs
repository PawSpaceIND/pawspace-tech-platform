import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import postcss from 'postcss';
import { installWorkersHooks } from './helpers/module-hooks.mjs';
// The resolver executes the real theme config and resolver modules (extensionless app imports resolve through the shared hook).
installWorkersHooks('__APPEARANCE_RESOLVER_DB__');
const { DEFAULT_THEME, SAFE_THEME, isConciergeAvailable, isOfferedTheme, resolveBrandTheme, themes } = await import('../app/mobile-app/theme-config.ts');
const { APPEARANCE_COOKIE, appearanceCookie, applyAppearanceEvent, effectiveTheme, initialRecordFromLegacy, parseAppearanceRecord, persistAppearanceRecord, resolveAppearance, serializeAppearanceRecord } = await import('../app/components/appearance-resolver.ts');

/** What a browser cookie jar keeps from a Set-Cookie string: the name and the value up to the first semicolon, attributes dropped. */
const jarValue = setCookie => { const first = setCookie.split(';')[0]; const at = first.indexOf('='); return { name: first.slice(0, at), value: first.slice(at + 1) }; };

const root = new URL('../', import.meta.url);
const read = p => fs.readFileSync(new URL(p, root), 'utf8');
const storage = values => ({ getItem: key => values[key] ?? null });

test('approved identities only: A is the default and safe theme, C is gated by the build flag', () => {
  assert.equal(SAFE_THEME, 'editorial');
  assert.equal(DEFAULT_THEME, 'editorial');
  assert.deepEqual(themes.map(t => t.id), ['editorial', 'concierge']);
  assert.equal(isConciergeAvailable(undefined), false);
  assert.equal(isConciergeAvailable('true'), true);
  assert.equal(isOfferedTheme('concierge', false), false);
  assert.equal(isOfferedTheme('concierge', true), true);
  for (const option of themes) assert.doesNotMatch(option.label + option.tagline, /price|payment|eligib|booking|provider|staff|rating/i);
});

test('record survives a real cookie jar: write, jar keeps name=value only, server parses the same record', () => {
  const record = { version: '1', explicit: 'concierge', assigned: 'editorial', mode: 'dark', legacy: 'theme~signature~style~cartoon' };
  const setCookie = appearanceCookie(record);
  assert.equal(setCookie, `${APPEARANCE_COOKIE}=v1.concierge.editorial.dark.theme~signature~style~cartoon; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
  const jar = jarValue(setCookie);
  assert.equal(jar.name, APPEARANCE_COOKIE);
  assert.equal(jar.value, 'v1.concierge.editorial.dark.theme~signature~style~cartoon', 'the whole record is inside the cookie value, no field is lost to attribute parsing');
  assert.match(jar.value, /^[A-Za-z0-9._~-]+$/, 'cookie-safe alphabet only');
  assert.equal(decodeURIComponent(jar.value), jar.value, 'a framework that percent-decodes the value cannot alter it');
  const server = resolveAppearance({ cookieValue: jar.value, conciergeAvailable: false });
  assert.deepEqual([server.explicit, server.assigned, server.mode, server.legacy, server.effective, server.recordPresent], ['concierge', 'editorial', 'dark', 'theme~signature~style~cartoon', 'editorial', true]);
  assert.deepEqual(parseAppearanceRecord(serializeAppearanceRecord(record)), { record, invalid: false });
  assert.doesNotMatch(setCookie, /HttpOnly/, 'presentation record stays readable by the client controller');
});

test('malformed, oversized, percent-escaped, unicode, duplicate or legacy-draft values never throw and resolve to safe A', () => {
  const bad = ['v1', 'v1;e=concierge;a=editorial;m=dark', 'v1;e=-;a=editorial;m=light;l=%', 'v1.-.editorial.light.%E0%A4', '%', '%E0%A4', 'v1.-.editorial.light.-.extra', 'v1.-.editorial.light', 'v1.B.editorial.light.-', 'v1.emerald.editorial.light.-', 'v1.-.editorial.fun.-', 'v1.-.editorial.light.theme~coral~theme~coral~theme~coral~theme~coral', 'v1.-.editorial.light.theme', 'v1.-.editorial.light.secret~token', 'v9.-.editorial.light.-', 'v1.-.editorial.light.-'.padEnd(10000, 'x'), 'v1.-.editorial.light.नमस्ते', 'v1.-.editorial.light.<script>', '\u0000', 'pawspace-appearance=v1.-.editorial.light.-'];
  for (const value of bad) {
    let snapshot;
    assert.doesNotThrow(() => { snapshot = resolveAppearance({ cookieValue: value, conciergeAvailable: true }); }, value);
    assert.equal(snapshot.effective, 'editorial', value);
    assert.equal(snapshot.invalidInput, true, value);
    assert.equal(snapshot.explicit, null, 'an invalid value is never shown as an explicit choice');
    assert.equal(snapshot.recordPresent, false, value);
  }
  for (const value of [null, undefined, '', 42, {}, [], true]) assert.doesNotThrow(() => resolveAppearance({ cookieValue: value }));
  assert.deepEqual(parseAppearanceRecord(''), { record: null, invalid: false });
  assert.deepEqual(parseAppearanceRecord(42), { record: null, invalid: true });
  // The serialiser is also bounded: unexpected field values are coerced instead of written out.
  assert.equal(serializeAppearanceRecord({ version: '1', explicit: 'B', assigned: 'x', mode: 'fun', legacy: 'theme=coral;style=cartoon' }), 'v1.-.editorial.system.-');
});

test('mode-only and repeated-theme events never erase a saved explicit C while the gate is closed', () => {
  const gatedC = { version: '1', explicit: 'concierge', assigned: 'editorial', mode: 'dark', legacy: null };
  assert.equal(effectiveTheme(gatedC, false), 'editorial');
  for (const mode of ['light', 'dark', 'system']) {
    // What the controller announces for a display change: the full record plus the effective theme.
    const viaRecord = applyAppearanceEvent(gatedC, { record: { ...gatedC, mode }, theme: 'editorial', mode }, false);
    assert.deepEqual([viaRecord.explicit, viaRecord.assigned, viaRecord.mode], ['concierge', 'editorial', mode]);
    // What a legacy writer announces: effective theme plus mode, no record.
    const viaExternal = applyAppearanceEvent(gatedC, { theme: 'editorial', mode }, false);
    assert.deepEqual([viaExternal.explicit, viaExternal.assigned, viaExternal.mode], ['concierge', 'editorial', mode]);
    assert.equal(effectiveTheme(viaExternal, false), 'editorial');
    assert.equal(effectiveTheme(viaExternal, true), 'concierge', 'reopening the gate renders the retained explicit C');
  }
  // An external writer announcing a different offered theme does set the explicit choice; a gated one does not.
  assert.equal(applyAppearanceEvent({ ...gatedC, explicit: null }, { theme: 'editorial' }, false).explicit, null);
  assert.equal(applyAppearanceEvent({ ...gatedC, explicit: null, assigned: 'concierge' }, { theme: 'editorial' }, true).explicit, 'editorial');
  assert.equal(applyAppearanceEvent({ ...gatedC, explicit: null }, { theme: 'concierge' }, false).explicit, null);
  // Malformed event payloads are ignored, not applied.
  for (const detail of [null, undefined, 'x', { record: 'v1' }, { record: { explicit: 'B' } }, { mode: 'fun' }, { theme: 'B' }]) assert.deepEqual(applyAppearanceEvent(gatedC, detail, false), { ...gatedC, ...(detail && detail.record && typeof detail.record === 'object' ? { explicit: null, mode: 'system', legacy: null } : {}) });
});

test('THEME-01/02/06: a device without a record is assigned the eligible new-user default once, explicit stays unset', () => {
  const a = resolveAppearance({ cookieValue: null, adminDefault: 'editorial', conciergeAvailable: false });
  assert.deepEqual([a.effective, a.assigned, a.explicit, a.recordPresent], ['editorial', 'editorial', null, false]);
  const c = resolveAppearance({ cookieValue: null, adminDefault: 'concierge', conciergeAvailable: true });
  assert.deepEqual([c.effective, c.assigned, c.explicit], ['concierge', 'concierge', null]);
  const gated = resolveAppearance({ cookieValue: null, adminDefault: 'concierge', conciergeAvailable: false });
  assert.deepEqual([gated.effective, gated.assigned, gated.explicit], ['editorial', 'editorial', null]);
});

test('THEME-03/04/05/08/30: explicit wins, assigned persists, the gate renders A without rewriting saved values', () => {
  const explicitA = resolveAppearance({ cookieValue: 'v1.editorial.concierge.system.-', adminDefault: 'concierge', conciergeAvailable: true });
  assert.deepEqual([explicitA.effective, explicitA.assigned, explicitA.explicit], ['editorial', 'concierge', 'editorial']);
  const explicitC = resolveAppearance({ cookieValue: 'v1.concierge.editorial.system.-', adminDefault: 'editorial', conciergeAvailable: true });
  assert.deepEqual([explicitC.effective, explicitC.assigned, explicitC.explicit], ['concierge', 'editorial', 'concierge']);
  const gatedExplicitC = resolveAppearance({ cookieValue: 'v1.concierge.editorial.system.-', adminDefault: 'editorial', conciergeAvailable: false });
  assert.deepEqual([gatedExplicitC.effective, gatedExplicitC.assigned, gatedExplicitC.explicit], ['editorial', 'editorial', 'concierge'], 'explicit C is retained while A renders');
  const assignedC = 'v1.-.concierge.light.-';
  assert.equal(resolveAppearance({ cookieValue: assignedC, adminDefault: 'editorial', conciergeAvailable: true }).effective, 'concierge');
  assert.equal(resolveAppearance({ cookieValue: assignedC, adminDefault: 'editorial', conciergeAvailable: false }).effective, 'editorial');
  assert.equal(resolveAppearance({ cookieValue: assignedC, adminDefault: 'editorial', conciergeAvailable: false }).assigned, 'concierge', 'the gate never rewrites the assignment');
  // A later admin default never changes an existing record.
  for (const admin of ['editorial', 'concierge']) assert.equal(resolveAppearance({ cookieValue: 'v1.-.editorial.system.-', adminDefault: admin, conciergeAvailable: true }).effective, 'editorial');
});

test('THEME-29/33/34/35: legacy device values migrate to A as inactive metadata; a modern explicit value wins', () => {
  const fresh = resolveAppearance({ cookieValue: null, conciergeAvailable: false });
  const professional = initialRecordFromLegacy(storage({ 'pawspace.customer.theme': 'emerald', 'pawspace.visual-style': 'professional' }), fresh);
  assert.deepEqual([professional.explicit, professional.assigned, professional.legacy], [null, 'editorial', 'theme~emerald']);
  const fun = initialRecordFromLegacy(storage({ 'pawspace.customer.theme': 'coral', 'pawspace.platform.default-theme': 'signature', 'pawspace.visual-style': 'cartoon', 'pawspace.customer.appearance': 'dark' }), fresh);
  assert.deepEqual([fun.explicit, fun.assigned, fun.mode, fun.legacy], [null, 'editorial', 'dark', 'theme~coral~platform~signature~style~cartoon']);
  assert.equal(effectiveTheme(fun, true), 'editorial', 'Fun or a legacy palette never activates B or a third UI');
  const modern = initialRecordFromLegacy(storage({ 'pawspace.customer.theme': 'concierge', 'pawspace.visual-style': 'cartoon' }), fresh);
  assert.deepEqual([modern.explicit, modern.legacy], ['concierge', 'style~cartoon']);
  assert.equal(effectiveTheme(modern, false), 'editorial');
  assert.equal(effectiveTheme(modern, true), 'concierge');
  const blocked = initialRecordFromLegacy({ getItem() { throw new Error('blocked'); } }, fresh);
  assert.deepEqual([blocked.explicit, blocked.assigned, blocked.legacy], [null, 'editorial', null]);
  const hostile = initialRecordFromLegacy(storage({ 'pawspace.customer.theme': 'x; Path=/; evil', 'pawspace.visual-style': 'cartoon' }), fresh);
  assert.equal(hostile.legacy, 'theme~invalid~style~cartoon', 'unsafe legacy values are recorded as invalid, never written raw');
  assert.match(appearanceCookie(hostile), /^pawspace-appearance=v1\.-\.editorial\.system\.theme~invalid~style~cartoon; /);
  const snapshotWithLegacy = resolveAppearance({ cookieValue: serializeAppearanceRecord(fun), conciergeAvailable: false });
  assert.equal(snapshotWithLegacy.legacyMoved, true);
  assert.equal(resolveBrandTheme('cartoon'), 'editorial');
});

test('THEME-13/14: the server snapshot is deterministic and the layout renders it on <html> without hydration suppression', () => {
  const cookie = 'v1.-.editorial.system.-';
  assert.deepEqual(resolveAppearance({ cookieValue: cookie, conciergeAvailable: false }), resolveAppearance({ cookieValue: cookie, conciergeAvailable: false }));
  const layout = read('app/layout.tsx');
  assert.match(layout, /const store = await cookies\(\);/);
  assert.match(layout, /await resolveRootAppearance\(\{ cookieValue: store\.get\(APPEARANCE_COOKIE\)\?\.value, cookieHeader: store\.toString\(\), trustedOrigin, acquireDb: database, resolveRequestAppearance \}\)/);
  assert.match(layout, /const appearance = root\.snapshot;/);
  assert.match(layout, /recordVersion: root\.recordVersion, accountAuthoritative: root\.accountAuthoritative/);
  assert.match(layout, /<html lang="en" data-paw-theme=\{appearance\.effective\} data-paw-mode=\{appearance\.mode\} data-paw-style="professional">/);
  assert.match(layout, /<PawSpaceAppearance initial=\{appearance\} account=\{accountHint\} \/>/);
  assert.doesNotMatch(layout, /suppressHydrationWarning|dangerouslySetInnerHTML|localStorage/);
  const controller = read('app/components/pawspace-appearance.tsx');
  assert.doesNotMatch(controller, /localStorage\.setItem|document\.cookie|fetch\(|XMLHttpRequest|customer-profile/, 'the controller itself holds no storage or direct network call');
  assert.match(controller, /import \{ accountDiffersFromDevice, isPositiveRecordVersion, readAccountAppearance, syncAccountAppearance \} from "\.\/appearance-account-client";/, 'account requests delegate to the reviewed bounded client');
  // The single cookie writer is the resolver helper: presentation record only, bounded values, never auth or role data.
  assert.equal(persistAppearanceRecord({ version: '1', explicit: null, assigned: 'editorial', mode: 'system', legacy: null }), false, 'no document outside a browser');
  const resolver = read('app/components/appearance-resolver.ts');
  assert.equal((resolver.match(/document\.cookie/g) || []).length, 1);
  assert.doesNotMatch(resolver, /fetch\(|XMLHttpRequest|identity-session|customer-profile|requirePermission/);
  assert.match(controller, /Your previous style has moved to Editorial Sanctuary\./);
  assert.match(controller, /Available after validation/);
  assert.doesNotMatch(controller, /paw-style"|"cartoon"|Fun/, 'Professional/Fun is no longer a selectable layout');
});

test('native A and C tokens keep text, link, accent ink and control borders readable in light, dark and system-dark', () => {
  const sheet = postcss.parse(read('app/pawspace-design-system.css'));
  const luminance = hex => { const c = hex.replace('#', '').match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722; };
  const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
  const collect = (theme, mode, insideDarkMedia) => {
    const out = {};
    sheet.walkRules(rule => {
      const inMedia = rule.parent?.type === 'atrule';
      if (inMedia && !(insideDarkMedia && /prefers-color-scheme:\s*dark/.test(rule.parent.params))) return;
      const matches = rule.selector.split(',').some(selector => {
        selector = selector.trim();
        if (!/^(?:html|:root)/.test(selector) || /\s|\./.test(selector)) return false;
        const t = selector.match(/data-paw-theme="([^"]+)"/), m = selector.match(/data-paw-mode="([^"]+)"/);
        return (!t || t[1] === theme) && (!m || m[1] === mode) && !selector.includes('data-paw-style');
      });
      if (matches) rule.walkDecls(d => { out[d.prop] = d.value; });
    });
    return out;
  };
  for (const theme of ['editorial', 'concierge']) for (const [mode, media] of [['light', false], ['dark', false], ['system', true]]) {
    const v = collect(theme, mode, media);
    const resolve = key => { const x = v[key]; return x?.startsWith('var(') ? resolve(x.slice(4, -1)) : x; };
    const pairs = [['--paw-text', '--paw-bg'], ['--paw-text', '--paw-surface'], ['--paw-text', '--paw-raised'], ['--paw-muted', '--paw-surface'], ['--paw-muted', '--paw-raised'], ['--paw-link', '--paw-surface'], ['--paw-link', '--paw-raised'], ['--paw-on-primary', '--paw-primary'], ['--paw-on-primary', '--paw-deep'], ['--ui-on-gold', '--paw-gold'], ['--paw-gold', '--paw-deep'], ['--paw-accent-ink', '--paw-surface'], ['--paw-accent-ink', '--paw-raised'], ['--paw-accent-ink', '--paw-bg']];
    for (const [f, b] of pairs) assert.ok(ratio(resolve(f), resolve(b)) >= 4.5, `${theme}/${mode}: ${f} on ${b} = ${ratio(resolve(f), resolve(b)).toFixed(2)}`);
    // Filled primary control: the label identifies the control (WCAG 1.4.11 text exception) and a boundary at 3:1 is always
    // available, either from the fill itself or from --paw-primary-edge against both canvas and surface.
    assert.ok(ratio(resolve('--paw-on-primary'), resolve('--paw-primary')) >= 4.5, `${theme}/${mode}: primary label`);
    for (const bg of ['--paw-surface', '--paw-bg', '--paw-raised']) assert.ok(ratio(resolve('--paw-primary-edge'), resolve(bg)) >= 3, `${theme}/${mode}: primary boundary (edge) on ${bg}`);
    // Focus ring (2.4.11) and selection indicator against every surface the control can sit on.
    for (const bg of ['--paw-surface', '--paw-bg', '--paw-raised']) {
      assert.ok(ratio(resolve('--paw-focus-ring'), resolve(bg)) >= 3, `${theme}/${mode}: focus ring on ${bg}`);
      assert.ok(ratio(resolve('--paw-link'), resolve(bg)) >= 3, `${theme}/${mode}: selection indicator on ${bg}`);
      assert.ok(ratio(resolve('--paw-control-line'), resolve(bg)) >= 3, `${theme}/${mode}: input border on ${bg}`);
    }
    if (mode === 'light') assert.equal(resolve('--paw-accent'), theme === 'editorial' ? '#C46E4D' : '#D8EA65');
    assert.match(resolve('--paw-display-font'), theme === 'editorial' ? /PawSpace Serif/ : /PawSpace Display/);
  }
  const css = read('app/pawspace-design-system.css');
  for (const face of ['NotoSans-Regular', 'NotoSans-Bold', 'NotoSerif-Regular', 'NotoSansDisplay-Bold']) {
    assert.match(css, new RegExp(`/fonts/noto/${face}\\.woff2`));
    assert.ok(fs.existsSync(new URL(`public/fonts/noto/${face}.woff2`, root)), face);
  }
  assert.ok(fs.existsSync(new URL('public/fonts/noto/LICENSE-NOTO.txt', root)));
  assert.match(css, /Accent fills are not text colours/);
  // Dark-mode boundary of filled primary controls: the fill alone is below 3:1, so the shared rules carry the 2px edge border.
  assert.match(css, /\.paw-appearance-dialog button\.paw-appearance-done\{[^}]*border:2px solid var\(--paw-primary-edge\)!important\}/, 'dialog Done button carries the primary edge border');
  assert.match(css, /\.ps-primary-fill\{background:var\(--paw-primary\);color:var\(--paw-on-primary\);border:2px solid var\(--paw-primary-edge\)\}/, 'shared filled-control helper carries the primary edge border');
  assert.match(css, /\.ps-focus:focus-visible\{outline:3px solid var\(--paw-focus-ring\)/, 'focus helper uses the per-theme ring token');
  assert.match(css, /:focus-visible\{outline:3px solid var\(--paw-focus-ring\)/, 'the global focus rule uses the per-theme ring token');
});
