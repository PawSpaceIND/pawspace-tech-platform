import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
installWorkersHooks("__V2_LOCATION_DRAFT_DB__");
const { requestGroomingLocationDraft } = await import("../lib/v2/grooming-location-draft.ts");
const point = { latitude: 12.9783692, longitude: 77.6408356 };
const address = "42 Indiranagar Double Road, Bengaluru 560038";
const mapped = { status: "configured", address, pincode: "560038", ...point };
const device = { getCurrentPosition: success => success({ coords: point }) };
function network(t, value = mapped) {
  const original = globalThis.fetch, calls = []; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return Response.json({ data: value }); };
  return calls;
}
test("G02 uses the existing reverse lookup but returns only an unverified text draft", async t => {
  const calls = network(t), result = await requestGroomingLocationDraft({ geolocation: device });
  assert.deepEqual(result, { address, pincode: "560038" }); assert.equal(calls.length, 1);
  const url = new URL(calls[0].url, "https://pawspace.test");
  assert.equal(url.pathname, "/api/address-autocomplete"); assert.equal(url.searchParams.get("mode"), "reverse");
  assert.equal(url.searchParams.get("latitude"), String(point.latitude));
  assert.equal(calls[0].init.cache, "no-store"); assert.equal(calls[0].init.method ?? "GET", "GET");
  assert.ok(calls[0].init.signal instanceof AbortSignal); assert.equal(calls[0].init.body, undefined);
});
test("G02 respects structured postal data even when a Google label omits the PIN", async t => {
  network(t, { ...mapped, address: "Indiranagar Main Road, Bengaluru" });
  assert.equal((await requestGroomingLocationDraft({ geolocation: device })).pincode, "560038");
});
test("G02 can use an explicit postal code in the map label, without guessing a locality", async t => {
  network(t, { ...mapped, pincode: undefined });
  assert.equal((await requestGroomingLocationDraft({ geolocation: device })).pincode, "560038");
});
for (const [name, changes] of [
  ["unconfigured maps", { status: "configuration_required" }],
  ["provider failure", { status: "provider_error" }],
  ["missing address", { address: undefined }],
  ["missing coordinate", { latitude: undefined }],
  ["different coordinate", { longitude: 77 }],
  ["string coordinate", { latitude: String(point.latitude) }],
  ["invalid structured PIN", { pincode: "5600" }],
  ["contradictory PIN", { pincode: "560102" }],
  ["missing PIN", { pincode: undefined, address: "Indiranagar Main Road, Bengaluru" }],
  ["invalid labelled PIN", { pincode: undefined, address: "Indiranagar Road, Bengaluru PIN 000000" }],
  ["two explicit PINs", { address: "Indiranagar Road PIN 560038, postal code 560102" }],
]) test(`G02 refuses ${name} instead of inventing a verified address`, async t => {
  const calls = network(t, { ...mapped, ...changes });
  await assert.rejects(requestGroomingLocationDraft({ geolocation: device })); assert.equal(calls.length, 1);
});
for (const code of [1, 2, 3]) test(`G02 device refusal ${code} preserves manual fallback and makes no API call`, async t => {
  const calls = network(t);
  await assert.rejects(requestGroomingLocationDraft({ geolocation: { getCurrentPosition: (_ok, fail) => fail({ code }) } }), /manually/);
  assert.equal(calls.length, 0);
});
test("G02 cancellation before permission does not read GPS or call an API", async t => {
  const calls = network(t), controller = new AbortController(); controller.abort();
  let gps = 0;
  await assert.rejects(requestGroomingLocationDraft({ signal: controller.signal, geolocation: { getCurrentPosition: () => { gps++; } } }), { name: "AbortError" });
  assert.equal(gps, 0); assert.equal(calls.length, 0);
});
test("G02 late GPS after cancellation never starts reverse lookup", async t => {
  const calls = network(t), controller = new AbortController(); let complete;
  const pending = requestGroomingLocationDraft({ signal: controller.signal, geolocation: { getCurrentPosition: ok => { complete = ok; } } });
  controller.abort(); complete({ coords: point });
  await assert.rejects(pending, { name: "AbortError" }); assert.equal(calls.length, 0);
});
test("G02 invalid GPS cannot enter reverse lookup", async t => {
  const calls = network(t);
  await assert.rejects(requestGroomingLocationDraft({ geolocation: { getCurrentPosition: ok => ok({ coords: { latitude: NaN, longitude: 77 } }) } }));
  assert.equal(calls.length, 0);
});
test("G02 non-JSON outage is surfaced without a fabricated suggestion", async t => {
  network(t); globalThis.fetch = async () => new Response("<html>Bad gateway</html>", { status: 502 });
  await assert.rejects(requestGroomingLocationDraft({ geolocation: device }), error => error.kind === "http" && error.status === 502);
});
test("G02 reverse lookup cancellation propagates to the response body", async t => {
  network(t); const controller = new AbortController();
  globalThis.fetch = async (_url, init) => new Response(new ReadableStream({ start(body) {
    init.signal.addEventListener("abort", () => body.error(new DOMException("Cancelled", "AbortError")), { once: true });
    queueMicrotask(() => controller.abort());
  } }));
  await assert.rejects(requestGroomingLocationDraft({ geolocation: device, signal: controller.signal }), { name: "AbortError" });
});
