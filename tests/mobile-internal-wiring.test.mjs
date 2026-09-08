import test from "node:test";
import assert from "node:assert/strict";
import { prepareGroomingPhoto } from "../lib/mobile/grooming-photo-client.ts";
import { resolveActiveWalkContext } from "../lib/mobile/walk-context.ts";

test("grooming capture registers metadata without claiming upload or approving proof", async () => {
  const previous = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/service-media");
    sent = JSON.parse(options.body);
    return Response.json({ data: { id: "media-1", ref: "media://asset/media-1", bookingId: "booking-1", proofReady: false, upload: { token: "private-token", adapterConnected: false } } }, { status: 201 });
  };
  try {
    const result = await prepareGroomingPhoto({ bookingId: "booking-1", purpose: "before_service", dataUrl: "data:image/jpeg;base64,AQID" });
    assert.equal(sent.sizeBytes, 3);
    assert.equal(sent.mimeType, "image/jpeg");
    assert.match(sent.sha256, /^[a-f0-9]{64}$/);
    assert.equal(sent.dataUrl, undefined);
    assert.equal(result.stage, "registered");
    assert.equal(result.proofReady, false);
    assert.equal(JSON.stringify(result).includes("private-token"), false);
  } finally { globalThis.fetch = previous; }
});

test("grooming registration rejects denied requests, wrong booking and invalid photos", async () => {
  const previous = globalThis.fetch;
  const input = { bookingId: "booking-1", purpose: "after_service", dataUrl: "data:image/png;base64,AQID" };
  try {
    for (const status of [400, 401, 403, 404, 409, 500]) {
      globalThis.fetch = async () => Response.json({ error: "internal stack trace" }, { status });
      await assert.rejects(prepareGroomingPhoto(input), /couldn't register this photo/);
    }
    globalThis.fetch = async () => Response.json({ data: { id: "m", ref: "media://m", bookingId: "another" } }, { status: 201 });
    await assert.rejects(prepareGroomingPhoto(input));
    await assert.rejects(prepareGroomingPhoto({ ...input, dataUrl: "data:text/html;base64,AQID" }));
  } finally { globalThis.fetch = previous; }
});

test("walk controls require the matching active sandbox session and provider", () => {
  const bookings = [{ id: "b", provider_id: "p", sessions: [{ id: "s", status: "in_progress" }] }];
  const proof = { bookingId: "b", providerId: "p", sandboxOnly: true };
  assert.deepEqual(resolveActiveWalkContext("b", "s", bookings, proof), { bookingId: "b", sessionId: "s", providerId: "p" });
  assert.throws(() => resolveActiveWalkContext("b", "other", bookings, proof));
  assert.throws(() => resolveActiveWalkContext("b", "s", bookings, { ...proof, providerId: "other" }));
  assert.throws(() => resolveActiveWalkContext("b", "s", bookings, { ...proof, sandboxOnly: false }));
  for (const status of ["scheduled", "completed", "cancelled"]) {
    assert.throws(() => resolveActiveWalkContext("b", "s", [{ ...bookings[0], sessions: [{ id: "s", status }] }], proof));
  }
});
