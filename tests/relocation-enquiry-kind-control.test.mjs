/**
 * STAFF-03. The public /relocation-enquiry form could never be submitted. lib/relocation-enquiry.ts requires
 * relocationKind ("domestic" or "international"), but the form had no control for it and its state never
 * carried the field, so every submission was answered 400 'Relocation type must be "domestic" or
 * "international"' and nothing ever reached /team/relocation-enquiries.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1 } from "./helpers/taxi-harness.mjs";

installWorkersHooks("__RELOCATION_KIND_DB__");

const source = readFileSync(new URL("../app/relocation-enquiry/page.tsx", import.meta.url), "utf8");
async function kindGroup() {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const page = await import("../app/relocation-enquiry/page.tsx");
  const group = renderToStaticMarkup(React.createElement(page.default)).match(/<fieldset[^>]*>([\s\S]*?)<\/fieldset>/)?.[1] ?? "";
  const options = [...group.matchAll(/<label[^>]*><input([^>]*)\/?>([^<]+)<\/label>/g)].map(([, attributes, text]) => ({ attributes, text: text.trim(), value: attributes.match(/value="([^"]*)"/)?.[1] }));
  return { legend: group.match(/<legend[^>]*>([^<]*)<\/legend>/)?.[1], options };
}

test("STAFF-03 the form asks 'Domestic or international?' with a labelled, keyboard-usable radio group and no preselected answer", async () => {
  const { legend, options } = await kindGroup();
  assert.equal(legend, "Domestic or international?", "the group is named by its legend");
  assert.deepEqual(options.map((option) => option.value), ["domestic", "international"]);
  for (const { attributes, text } of options) {
    assert.match(attributes, /type="radio"/); assert.match(attributes, /name="relocationKind"/);
    assert.doesNotMatch(attributes, /checked/, "the customer chooses; the form does not guess");
    assert.ok(text.length > 0, "each option has visible label text");
  }
});

test("STAFF-03 the page keeps relocationKind in the form state it posts", () => {
  assert.match(source, /type FormState=\{[^}]*relocationKind:""\|"domestic"\|"international"/);
  assert.match(source, /const empty:FormState=\{[^}]*relocationKind:""/);
  assert.match(source, /onChange=\{e=>set\("relocationKind",e\.target\.value\)\}/);
  assert.match(source, /body:JSON\.stringify\(\{\.\.\.form,phoneSecondary:form\.phoneSecondary\|\|undefined\}\)/, "the whole form state is the request body");
});

test("STAFF-03 the page's payload is accepted and reaches the staff list; without relocationKind it is still refused 400", async () => {
  const sqlite = freshSqlite(), db = makeD1(sqlite);
  globalThis.__RELOCATION_KIND_DB__ = db;
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-RELOC-DESK','relocation.desk@pawspace.test','Relocation desk','associate','active',?,?)").run(now, now);
  const route = await import("../app/api/relocation-enquiry/route.ts");
  const post = async (body) => { const response = await route.POST(new Request("https://uat.pawspace.in/api/relocation-enquiry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })); return { status: response.status, body: await response.json() }; };
  // What a customer types plus the option they pick in the rendered group; the body is built the way the page builds it.
  const picked = (await kindGroup()).options.find((option) => option.value === "international");
  assert.ok(picked, "the rendered group offers international");
  const form = { customerName: "Asha Menon", phonePrimary: "9876543210", phoneSecondary: "", email: "asha@example.in", petType: "dog", relocationKind: picked.value, pickupDate: "2099-11-01", pickupApproxTime: "10:00", pickupLocation: "Indiranagar, Bengaluru", dropLocation: "Dubai, UAE", expectedTravelDate: "2099-11-05" };
  const body = { ...form, phoneSecondary: form.phoneSecondary || undefined };
  const created = await post(body);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.data.relocationKind, "international");
  const list = await route.GET(new Request("https://uat.pawspace.in/api/relocation-enquiry", { headers: { "oai-authenticated-user-email": "relocation.desk@pawspace.test" } }));
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).data.map((row) => [row.id, row.relocationKind]), [[created.body.data.id, "international"]], "the enquiry is what /team/relocation-enquiries lists");
  // Server validation is unchanged: no answer, or no field at all, is still refused.
  const withoutKind = { ...body }; delete withoutKind.relocationKind;
  for (const refused of [{ ...body, relocationKind: "" }, withoutKind]) {
    const result = await post(refused);
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'Relocation type must be "domestic" or "international"');
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM relocation_enquiries").get().n, 1);
});
