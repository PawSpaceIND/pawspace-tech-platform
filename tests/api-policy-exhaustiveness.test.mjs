import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const API_ROOT = new URL("../app/api", import.meta.url).pathname;
const gateway = await readFile(new URL("../lib/api-gateway.ts", import.meta.url), "utf8");
const HTTP_METHOD = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g;

async function apiSurface() {
  const entries = await readdir(API_ROOT, { withFileTypes: true });
  const surface = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const source = await readFile(join(API_ROOT, entry.name, "route.ts"), "utf8").catch(() => "");
    if (!source) continue;
    const methods = [...source.matchAll(HTTP_METHOD)].map((match) => match[1]);
    assert.ok(methods.length > 0, `/api/${entry.name} has route.ts but no exported HTTP method`);
    surface.push({ route: `/api/${entry.name}`, methods: [...new Set(methods)].sort() });
  }
  return surface.sort((a, b) => a.route.localeCompare(b.route));
}

test("every API route is explicitly present in the authoritative gateway registry", async () => {
  const surface = await apiSurface();
  const missing = surface.filter(({ route }) => !gateway.includes(`url.pathname===\"${route}\"`));
  assert.deepEqual(
    missing,
    [],
    `These API routes still rely on the implicit dashboard.view fallback instead of an explicit policy entry:\n${JSON.stringify(missing, null, 2)}`,
  );
});

test("the generated API surface has no duplicate route/method pairs", async () => {
  const surface = await apiSurface();
  const pairs = surface.flatMap(({ route, methods }) => methods.map((method) => `${method} ${route}`));
  assert.equal(new Set(pairs).size, pairs.length);
});
