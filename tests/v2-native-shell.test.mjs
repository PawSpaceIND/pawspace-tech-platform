import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import postcss from "postcss";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__V2_NATIVE_SHELL_DB__");
const { renderToStaticMarkup } = await import("react-dom/server");
const { markNativeShell, default: V2NativeShell } = await import("../app/v2/native-shell.tsx");
const { default: V2Layout } = await import("../app/v2/layout.tsx");
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const device = (native, platform) => ({ isNative: () => native, getPlatform: () => platform });
const NATIVE = "html[data-pawspace-native]";

test("V2 marks the page as native only inside the PawSpace app shell", () => {
  for (const platform of ["android", "ios"]) {
    const root = { dataset: {} };
    assert.equal(markNativeShell(root, device(true, platform)), true);
    assert.deepEqual(root.dataset, { pawspaceNative: platform });
  }
  const web = { dataset: {} };
  assert.equal(markNativeShell(web, device(false, "web")), false);
  assert.deepEqual(web.dataset, {}, "a browser gets no native marker");
  // The default device is the shared lib/mobile bridge (Capacitor), which reports the web outside the app shell.
  const runtime = { dataset: {} };
  assert.equal(markNativeShell(runtime), false);
  assert.deepEqual(runtime.dataset, {});
  assert.match(read("app/v2/native-shell.tsx"), /import \{ PawSpaceDevice \} from "\.\.\/\.\.\/lib\/mobile\/index";/);
});

test("every V2 route mounts the native shell inside the V2 boundary without changing its markup", () => {
  const element = V2Layout({ children: "page" });
  assert.equal(element.props["data-pawspace-v2"], "true");
  const children = [element.props.children].flat();
  assert.equal(children[0].type, V2NativeShell);
  assert.equal(children.at(-1), "page");
  assert.equal(renderToStaticMarkup(element), '<div data-pawspace-v2="true" class="canvas surface">page</div>');
});

function v2Css() {
  return readdirSync(new URL("../app/v2", import.meta.url), { recursive: true })
    .filter(name => String(name).endsWith(".css"))
    .map(name => [`app/v2/${name}`, postcss.parse(read(`app/v2/${name}`))]);
}
function nativeRule(path, selector, media) {
  let found = null;
  postcss.parse(read(path)).walkRules(rule => {
    if (rule.selector.replace(/\s+/g, " ").trim() !== selector) return;
    const at = rule.parent?.type === "atrule" ? rule.parent.params.replace(/\s+/g, "") : null;
    if (at === (media ?? null)) found = Object.fromEntries(rule.nodes.filter(node => node.type === "decl").map(node => [node.prop, node.important ? `${node.value} !important` : node.value]));
  });
  assert.ok(found, `${path}: ${selector}${media ? ` inside @media ${media}` : ""}`);
  return found;
}

test("the status-bar inset is applied in the native app only, so V2 on the web is unchanged", () => {
  let scoped = 0;
  for (const [path, css] of v2Css()) {
    css.walkDecls(decl => {
      if (!/safe-area-inset-(top|left|right)/.test(decl.value)) return;
      for (const selector of decl.parent.selectors) assert.ok(selector.includes(`:global(${NATIVE}`), `${path}: ${selector} must be scoped to the native app`);
      scoped++;
    });
  }
  assert.ok(scoped >= 8, `expected the native safe-area rules, found ${scoped}`);
});

test("in the native app V2 content, sticky bar, home utilities and chat pane clear the status bar", () => {
  const canvas = nativeRule("app/v2/presentation.module.css", `:global(${NATIVE}) .canvas`);
  assert.equal(canvas["padding-top"], "env(safe-area-inset-top, 0px)");
  assert.equal(canvas["padding-left"], "env(safe-area-inset-left, 0px)");
  assert.equal(canvas["padding-right"], "env(safe-area-inset-right, 0px)");
  const backdrop = nativeRule("app/v2/presentation.module.css", `:global(${NATIVE}) .canvas::before`);
  assert.equal(backdrop.position, "fixed");
  assert.equal(backdrop.top, "0");
  assert.equal(backdrop.height, "env(safe-area-inset-top, 0px)");
  assert.equal(backdrop["pointer-events"], "none");
  assert.ok(Number(backdrop["z-index"]) > 80 && Number(backdrop["z-index"]) < 100, "above the sticky bar and docks, below V2 dialogs");

  assert.equal(nativeRule("app/v2/service-bridge-shell.module.css", `:global(${NATIVE}) .bar`).top, "env(safe-area-inset-top,0px)");
  assert.match(read("app/v2/service-bridge-shell.module.css"), /^\.bar\{position:sticky;top:0;/, "the web keeps the bar at the top");

  const utilities = nativeRule("app/v2/style-options.module.css",
    `:global(${NATIVE} body:has([data-v2-home]) .paw-appearance-trigger), :global(${NATIVE} body:has([data-v2-home]) .ps-order-fab)`, "(max-width:820px)");
  assert.equal(utilities.top, "calc(14px + env(safe-area-inset-top,0px))");

  assert.equal(nativeRule("app/v2/chat/page.module.css", `:global(${NATIVE}) .page .chatShell`).height, "calc(100vh - 110px - env(safe-area-inset-top,0px)) !important");
  assert.equal(nativeRule("app/v2/chat/page.module.css", `:global(${NATIVE}) .page .chatShell`, "(max-width:640px)").height, "calc(100dvh - 84px - env(safe-area-inset-top,0px)) !important");
});
