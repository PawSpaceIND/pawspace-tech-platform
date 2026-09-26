import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1, OPS_ORIGIN } from "./helpers/taxi-harness.mjs";

// The shared account address form: Google Places search on the existing autocomplete client, above plain
// editable fields, embedded by /v2/account and the mobile Account tab. Executed in three layers:
// 1. the pure helper that turns a Google result into line1 and a PIN, including the real sandbox fixture;
// 2. the component's first render with react-dom/server (effects do not run; nothing may be requested on
//    mount anyway), and the V2 client the V2 host saves through;
// 3. source contracts that behaviour alone cannot express (no IO of its own, no booking draft).
installWorkersHooks("__ACCOUNT_ADDRESS_SEARCH_DB__");
const ENV = "__ACCOUNT_ADDRESS_SEARCH_DB___ENV";
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const helper = () => import("../lib/account-address-search.ts");
const suggestion = (fullText, placeId = "place-1") => {
  const [mainText, ...rest] = fullText.split(", ");
  return { placeId, mainText, secondaryText: rest.join(", "), fullText };
};

test("a structured Google PIN is used first, including when the formatted address carries none", async () => {
  const { addressFromResolvedPlace } = await helper();
  // The live sandbox returns labels without a PIN (QA evidence, run 36243387701): the structured code is the source.
  const domlur = suggestion("HAL Old Airport Road, Domlur, Bengaluru, Karnataka, India");
  assert.deepEqual(
    addressFromResolvedPlace({ status: "configured", address: "HAL Old Airport Rd, Domlur, Bengaluru, Karnataka, India", pincode: "560071" }, domlur),
    { line1: "HAL Old Airport Rd, Domlur, Bengaluru, Karnataka", postalCode: "560071" },
  );
  assert.equal(
    addressFromResolvedPlace({ status: "configured", address: "100 Feet Rd, Indiranagar, Bengaluru, Karnataka 560038, India", pincode: "560008" }, domlur).postalCode,
    "560008",
    "the structured postal code wins over a PIN in the text",
  );
});

test("without a structured PIN the last postal PIN in the text is used, never a labelled flat number", async () => {
  const { addressFromResolvedPlace } = await helper();
  const configured = (address) => addressFromResolvedPlace({ status: "configured", address }, suggestion(address));
  assert.equal(configured("42, Indiranagar Double Road, Stage 2, Hoysala Nagar, Indiranagar, Bengaluru 560038").postalCode, "560038");
  assert.equal(configured("Flat 123456, BTM Layout, Bengaluru 560076").postalCode, "560076");
  assert.equal(configured("12 Test Lane, Bengaluru 056003").postalCode, "", "a candidate that fails the server's rule is dropped");
});

test("no PIN anywhere leaves the PIN empty: an area name is never mapped to one", async () => {
  const { addressFromResolvedPlace, addressFromSuggestionText } = await helper();
  const jayanagar = "18th Main Road, Jayanagar 9th Block, Jayanagar, Bengaluru, Karnataka, India";
  assert.deepEqual(addressFromResolvedPlace({ status: "configured", address: jayanagar }, suggestion(jayanagar)), { line1: "18th Main Road, Jayanagar 9th Block, Jayanagar, Bengaluru, Karnataka", postalCode: "" });
  assert.deepEqual(addressFromSuggestionText(suggestion(jayanagar)), { line1: "18th Main Road, Jayanagar 9th Block, Jayanagar, Bengaluru, Karnataka", postalCode: "" });
});

test("a resolve that is not configured yields null, and the suggestion text is the fallback", async () => {
  const { addressFromResolvedPlace, addressFromSuggestionText } = await helper();
  const chosen = suggestion("42, Indiranagar Double Road, Indiranagar, Bengaluru 560038, India");
  for (const status of ["configuration_required", "provider_error"]) assert.equal(addressFromResolvedPlace({ status, error: "unavailable" }, chosen), null, status);
  assert.deepEqual(addressFromSuggestionText(chosen), { line1: "42, Indiranagar Double Road, Indiranagar, Bengaluru 560038", postalCode: "560038" });
  // An empty resolved address keeps the customer's chosen text rather than blanking the field.
  assert.deepEqual(addressFromResolvedPlace({ status: "configured", address: "", pincode: "560038" }, chosen), { line1: "42, Indiranagar Double Road, Indiranagar, Bengaluru 560038", postalCode: "560038" });
});

test("the real sandbox fixture fills 560038, and the live-mode lock falls back to the suggestion text", async () => {
  const { addressFromResolvedPlace, addressFromSuggestionText } = await helper();
  const maps = await import("../lib/address-autocomplete.ts");
  try {
    globalThis[ENV] = { PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE: "on" };
    const found = await maps.searchAddressSuggestions({ query: "Indiranagar", sessionToken: "account-form-test" });
    assert.equal(found.status, "configured");
    const [chosen] = found.suggestions;
    const place = await maps.resolvePlaceToAddress({ placeId: chosen.placeId, sessionToken: "account-form-test" });
    assert.equal(place.pincode, undefined, "the fixture resolve carries its PIN only in the text");
    assert.deepEqual(addressFromResolvedPlace(place, chosen), { line1: "42, Indiranagar Double Road, Stage 2, Hoysala Nagar, Indiranagar, Bengaluru 560038", postalCode: "560038" });
    globalThis[ENV] = { PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE: "on", PAWSPACE_MAPS_ENV: "live" };
    const locked = await maps.resolvePlaceToAddress({ placeId: chosen.placeId, sessionToken: "account-form-test" });
    assert.equal(locked.status, "configuration_required");
    assert.equal(addressFromResolvedPlace(locked, chosen), null);
    assert.equal(addressFromSuggestionText(chosen).postalCode, "560038");
  } finally {
    delete globalThis[ENV];
  }
});

// The form says "PawSpace doesn't serve this PIN yet" only for the server's refusal. A check that could not run
// (network, a 500, a non-JSON gateway page, an abort) must not tell a customer in a served zone they are not served.
test("a coverage refusal is told apart from a check that failed, with the message unchanged", async () => {
  const { resolveServiceCoverage, ServiceCoverageRefusal } = await import("../lib/service-zone-client.ts");
  const route = await import("../app/api/service-zone/route.ts");
  const db = makeD1(freshSqlite());
  globalThis.__ACCOUNT_ADDRESS_SEARCH_DB__ = db;
  await (await import("../lib/service-zones.ts")).seedDefaultZones(db);
  const original = globalThis.fetch;
  const outcome = (pin) => resolveServiceCoverage(pin).then(() => null, (error) => error);
  try {
    // The real route: a served PIN, a PIN with no zone (404) and a PIN in a paused city (409).
    globalThis.fetch = async (url, init) => route.GET(new Request(`${OPS_ORIGIN}${url}`, init));
    assert.equal((await resolveServiceCoverage("560038")).zoneName, "East Bengaluru");
    const unzoned = await outcome("110001");
    assert.ok(unzoned instanceof ServiceCoverageRefusal, "404: no zone for the PIN is a refusal");
    assert.equal(unzoned.message, "Zone not found for this pincode");
    const now = Date.now();
    await db.prepare("CREATE TABLE IF NOT EXISTS city_launch_configs (id TEXT PRIMARY KEY,city_code TEXT NOT NULL UNIQUE,city TEXT NOT NULL,state TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'Draft',centre TEXT NOT NULL DEFAULT '',radius_km REAL NOT NULL DEFAULT 15,pincodes TEXT NOT NULL DEFAULT '',gst_included INTEGER NOT NULL DEFAULT 1,services_json TEXT NOT NULL DEFAULT '{}',version INTEGER NOT NULL DEFAULT 1,updated_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)").run();
    await db.prepare("INSERT OR REPLACE INTO city_launch_configs (id,city_code,city,state,status,centre,radius_km,pincodes,updated_by,created_at,updated_at) VALUES ('CLC-BLR','blr','Bengaluru','Karnataka','Paused','MG Road',15,'560038',?,?,?)").bind("ops@pawspace.test", now, now).run();
    const paused = await outcome("560038");
    assert.ok(paused instanceof ServiceCoverageRefusal, "409: a city that is not open is a refusal");
    assert.equal(paused.message, "PawSpace is not currently serving this area");

    globalThis.fetch = async () => Response.json({ data: { zone: { zoneId: "blr-east", zoneName: "East Bengaluru", serviceAvailable: false }, assignment: { pincode: "560038", zoneId: "blr-east", cityId: "blr", city: "Bengaluru", area: "Indiranagar" } } });
    const unavailable = await outcome("560038");
    assert.ok(unavailable instanceof ServiceCoverageRefusal, "a zone that is not available is a refusal");
    assert.equal(unavailable.message, "PIN code 560038 is outside the currently enabled service area.");

    // Failures are plain errors: the form must not read any of them as "not served".
    const failures = {
      "a 500 with a JSON error": async () => Response.json({ error: "D1_ERROR: database is locked" }, { status: 500 }),
      "a non-JSON gateway page": async () => new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } }),
      "a network failure": async () => { throw new TypeError("Failed to fetch"); },
      "an abort": async () => { throw new DOMException("The operation was aborted.", "AbortError"); },
      "a 200 without a zone": async () => Response.json({ productionReady: false }),
    };
    for (const [name, respond] of Object.entries(failures)) {
      globalThis.fetch = respond;
      const failed = await outcome("560038");
      assert.ok(failed instanceof Error, `${name} still rejects`);
      assert.ok(!(failed instanceof ServiceCoverageRefusal), `${name} is not a refusal`);
    }
    globalThis.fetch = failures["a 500 with a JSON error"];
    assert.equal((await outcome("560038")).message, "D1_ERROR: database is locked", "callers that show the message see the same text");
  } finally {
    globalThis.fetch = original;
    delete globalThis.__ACCOUNT_ADDRESS_SEARCH_DB__;
  }
});

async function render(exportName, props) {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const mod = await import("../app/mobile-app/account-address-form.tsx");
  return renderToStaticMarkup(React.createElement(mod[exportName], props));
}
const inputWith = (html, attribute) => {
  const found = [...html.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]).filter((tag) => attribute.test(tag));
  assert.equal(found.length, 1, `exactly one input matches ${attribute}`);
  return found[0];
};
const noop = async () => {};

test("the first render offers Maps search outside a manual form whose PIN field is required and strict", async () => {
  const html = await render("default", { busy: false, onSave: noop });
  const search = inputWith(html, /type="search"/);
  const searchId = search.match(/id="([^"]+)"/)[1];
  assert.ok(html.includes(`for="${searchId}">Search your address</label>`), "the search field is labelled");
  const formStart = html.indexOf("<form"), formEnd = html.indexOf("</form>");
  assert.ok(html.indexOf(search) < formStart, "search sits above the fields");
  assert.ok(!html.slice(formStart, formEnd).includes('type="search"'), "Enter in the search box can never submit the address");
  const pin = inputWith(html, /autocomplete="postal-code"/i);
  for (const attribute of [/required=""/, /pattern="\[1-9\]\[0-9\]\{5\}"/, /inputmode="numeric"/i, /maxlength="6"/i, /value=""/]) assert.match(pin, attribute);
  assert.match(inputWith(html, /autocomplete="address-line1"/i), /required=""/, "Address is required");
  const city = inputWith(html, /autocomplete="address-level2"/i);
  assert.match(city, /required=""/, "City is required");
  assert.match(city, /value="Bengaluru"/);
  assert.match(html, /<label class="label">Label<input[^>]*value="Home"/);
  assert.match(html, /<label class="label">Flat, floor or landmark<input/);
  assert.match(html, /<button class="primary">Save address<\/button>/);
  assert.match(html, />Add default address</);
  for (const absent of ["Google address suggestions", "Cancel", "Use my location", "autofocus"]) assert.ok(!html.includes(absent), `${absent} is not in the first render`);
});

test("a saved row loads into the form for editing, and the host controls the label and busy state", async () => {
  const html = await render("default", { busy: false, onSave: noop, onCancel() {}, initial: { id: "ADDR-LEGACY", label: "Office", line1: "12 Test Lane", line2: "Floor 2", area: "Indiranagar", city: "Mysuru", postalCode: null } });
  assert.match(html, />Update this saved address</);
  for (const value of ['value="Office"', 'value="12 Test Lane"', 'value="Floor 2"', 'value="Indiranagar"', 'value="Mysuru"']) assert.ok(html.includes(value), value);
  const pin = inputWith(html, /autocomplete="postal-code"/i);
  assert.match(pin, /value=""/);
  assert.match(pin, /autofocus=""/, "the missing PIN is where the cursor lands");
  assert.match(html, /<button type="button" class="secondary">Cancel<\/button>/);
  const busy = await render("default", { busy: true, submitLabel: "Save address", onSave: noop });
  assert.match(busy, /<button class="primary" disabled="">Saving…<\/button>/);
  assert.match(await render("default", { busy: false, submitLabel: "Keep this address", onSave: noop }), /<button class="primary">Keep this address<\/button>/);
});

test("a saved address without a PIN is flagged with an Add PIN code action", async () => {
  const html = await render("MissingPin", { onAdd() {} });
  assert.match(html, /PIN code missing: add it to book Training and stays/);
  assert.match(html, /<button type="button" class="secondary">Add PIN code<\/button>/);
  assert.match(await render("MissingPin", { onAdd() {}, disabled: true }), /<button type="button" class="secondary" disabled="">Add PIN code<\/button>/);
});

test("the V2 save path sends the row id and PIN, and surfaces the server's PIN refusal", async () => {
  const { upsertV2CustomerAddress } = await import("../lib/v2/customer-experience-client.ts");
  const original = globalThis.fetch, requests = [];
  try {
    globalThis.fetch = async (url, init) => {
      requests.push({ url, method: init.method, body: JSON.parse(init.body) });
      return Response.json({ data: { entityId: "ADDR-LEGACY" } }, { status: 201 });
    };
    await upsertV2CustomerAddress({ id: "ADDR-LEGACY", label: "Home", line1: "12 Test Lane", line2: null, area: "Indiranagar", city: "Bengaluru", postalCode: "560038", isDefault: true, idempotencyKey: "v2-address-test" });
    assert.deepEqual(requests, [{ url: "/api/customer-account", method: "POST", body: { action: "upsert_address", idempotencyKey: "v2-address-test", address: { id: "ADDR-LEGACY", label: "Home", line1: "12 Test Lane", line2: null, area: "Indiranagar", city: "Bengaluru", postalCode: "560038", isDefault: true } } }]);
    globalThis.fetch = async () => Response.json({ error: "Enter a 6-digit PIN code", code: "invalid_postal_code" }, { status: 400 });
    await assert.rejects(upsertV2CustomerAddress({ label: "Home", line1: "12 Test Lane", city: "Bengaluru", postalCode: "", idempotencyKey: "v2-address-refused" }), { message: "Enter a 6-digit PIN code" });
  } finally {
    globalThis.fetch = original;
  }
});

test("the form reuses the Places client and the server's rule, and does no IO of its own", () => {
  const form = read("app/mobile-app/account-address-form.tsx");
  assert.match(form, /^"use client";\n/);
  for (const used of ["searchAddresses(", "resolveAddress(", "createAddressSessionToken", "resolveServiceCoverage(", "customerAddressIssue(", "serviceAddressConflict(", "addressFromResolvedPlace(", "addressFromSuggestionText("]) assert.ok(form.includes(used), used);
  for (const banned of ["fetch(", "sessionStorage", "localStorage", "SELECTED_SERVICE_ADDRESS_KEY", "inferPin", "AREA_PIN", "googleapis", "/api/address-autocomplete", "address-picker", "reverseGeocodeCoordinates", "Use my location"]) assert.ok(!form.includes(banned), `the form must not contain ${banned}`);
  // Nothing runs on mount: the only effect returns its unmount cleanup and does nothing else.
  assert.equal(form.match(/useEffect\(/g).length, 1);
  assert.match(form, /useEffect\(\(\)=>\(\)=>\{[^}]*\},\[\]\);/);
  assert.match(form, /aria-label="Google address suggestions"/);
  assert.match(form, /Suggestions from Google Maps<\/p>/, "predictions shown without a map carry a Google Maps attribution");
  // "Not served" is only for the server's refusal; any other failure says the check could not run.
  assert.match(form, /catch\(problem\)\{if\(request===generation\.current\)setCoverageNote\(\{pincode:next\.postalCode,text:problem instanceof ServiceCoverageRefusal\?NOT_SERVED:COVERAGE_UNCHECKED\}\);\}/);
  assert.equal(form.match(/NOT_SERVED/g).length, 2, "NOT_SERVED is declared once and used once");
  assert.match(form, /const COVERAGE_UNCHECKED="We couldn't check coverage for this PIN right now\. You can still save it; bookings check coverage\.";/);
  // Its helper takes the autocomplete types only; that module's runtime is server-side.
  const lib = read("lib/account-address-search.ts");
  assert.match(lib, /^import type\{AddressSuggestion,ResolvedAddress\}from"\.\/address-autocomplete";$/m);
  assert.equal(lib.match(/"\.\/address-autocomplete"/g).length, 1);
});

test("both account screens embed the shared form and flag PIN-less rows", () => {
  const v2 = read("app/v2/account/page.tsx"), mobile = read("app/mobile-app/customer-account-view.tsx");
  for (const [name, host] of [["V2", v2], ["mobile", mobile]]) {
    assert.match(host, /<AccountAddressForm key=\{editing\?\.id\|\|"new"\}/, `${name} remounts the form for each row it edits`);
    assert.match(host, /initial=\{editing\|\|undefined\}/, name);
    assert.match(host, /\{!a\.postalCode&&<MissingPin onAdd=\{\(\)=>setEditing\(a\)\}/, name);
    assert.match(host, /serviceAddressText\(a\)/, name);
    assert.doesNotMatch(host, /name="postal"/, `${name} keeps no second address form`);
  }
  assert.match(v2, /upsertV2CustomerAddress\(\{\.\.\.address,isDefault:true,idempotencyKey:"v2-address-"\+crypto\.randomUUID\(\)\}\)/);
  assert.match(v2, /submitLabel="Save address"/);
  assert.match(v2, /setError\(p instanceof Error\?p\.message:"We could not save your address\."\);throw p;/, "V2 rethrows so the form keeps the customer's input");
  assert.match(mobile, /if\(!r\.ok\)throw new Error\(body\.error\|\|"Update failed"\);await refresh\(\);flash\("Address saved"\);/, "the mobile save throws on failure instead of reporting success");
  assert.match(mobile, /fetch\("\/api\/customer-account",\{cache:"no-store"\}\)/, "the account read stays live");
});
