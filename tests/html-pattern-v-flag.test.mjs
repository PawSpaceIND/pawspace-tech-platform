/**
 * QA (L6): Chrome compiles an input's pattern attribute with the RegExp `v` flag. "[0-9+\s-]" is a syntax error
 * there, so the enquiry phone check was silently skipped. Every pattern literal in app/ must compile with `v`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

const root = new URL("../app/", import.meta.url).pathname;
function patterns(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) patterns(file, found);
    else if (file.endsWith(".tsx")) for (const match of fs.readFileSync(file, "utf8").matchAll(/pattern="([^"]*)"/g)) found.push({ file, pattern: match[1] });
  }
  return found;
}
test("every input pattern in the app compiles the way Chrome compiles it", () => {
  const all = patterns(root);
  assert.ok(all.length > 0);
  for (const { file, pattern } of all) assert.doesNotThrow(() => new RegExp(`^(?:${pattern})$`, "v"), `${file}: ${pattern}`);
});
installWorkersHooks("__HTML_PATTERN_DB__");
async function renderedPatterns(modulePath, props) {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const { default: Form } = await import(modulePath);
  return [...renderToStaticMarkup(React.createElement(Form, props)).matchAll(/pattern="([^"]*)"/g)].map(match => match[1].replaceAll("&amp;", "&"));
}
test("the rendered enquiry phone fields accept Indian numbers and reject letters, as Chrome checks them", async () => {
  const rendered = [
    ...await renderedPatterns("../app/contact/contact-form.tsx", {}),
    ...await renderedPatterns("../app/landing-pages/landing-lead-form.tsx", { service: "grooming", pet: "dog", formTitle: "Book", formCta: "Send" }),
  ];
  assert.ok(rendered.length >= 2);
  for (const pattern of rendered) {
    const phone = new RegExp(`^(?:${pattern})$`, "v");
    assert.ok(phone.test("+91 98765-43210"), pattern);
    assert.ok(!phone.test("call me later"), pattern);
  }
});
