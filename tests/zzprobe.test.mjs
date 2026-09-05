import test from "node:test";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1, seedBoardingStay, validCarePlan, nextKey } from "./helpers/stay-harness.mjs";

installWorkersHooks("__PROBE_DB__", "__PROBE_ENV__");
const proof = await import("../lib/boarding-proof-governance.ts");
const lifecycle = await import("../lib/boarding-stay-lifecycle.ts");

const show = async (label, fn) => {
  try { const v = await fn(); console.log("PROBE", label, "OK", JSON.stringify(v ?? null).slice(0, 400)); return v; }
  catch (e) { console.log("PROBE", label, "REFUSED", e instanceof Response ? `${e.status} ${(await e.text()).slice(0, 200)}` : String(e).slice(0, 200)); return null; }
};

test("probe", async () => {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__PROBE_DB__ = db;
  globalThis.__PROBE_ENV__ = {};
  const live = { scheduledStart: new Date(Date.now() - 3.6e6).toISOString(), scheduledEnd: new Date(Date.now() + 7.2e6).toISOString() };
  const s = await seedBoardingStay(db, sqlite, { window: live });
  await proof.ensureBoardingProofTables(db);
  const stayAct = (a, x = {}) => lifecycle.mutateBoardingStay(db, { stayId: s.stayId, action: a, actorId: x.actorId ?? s.providerId, idempotencyKey: nextKey("P"), ...x });
  await stayAct("accept");
  await stayAct("submit_care_plan", { carePlan: validCarePlan({ medication: "Amoxicillin 250mg twice daily" }), actorId: s.customerId });
  await stayAct("check_in");
  const g = await show("prepare", () => proof.prepareBoardingMedia(db, { stayId: s.stayId, action: "prepare_media", actorId: s.providerId, idempotencyKey: nextKey("PM"), purpose: "stay_update", mimeType: "image/jpeg", sizeBytes: 240000, sha256: "a".repeat(64) }));
  console.log("PROBE grantrow", JSON.stringify(sqlite.prepare("SELECT * FROM boarding_media_upload_grants").all()).slice(0, 400));
  console.log("PROBE assetrow", JSON.stringify(sqlite.prepare("SELECT id,storage_key,scan_status,access_status,retention_status,synthetic,purpose FROM service_media_assets").all()).slice(0, 400));
  const act = (a, x = {}) => proof.mutateBoardingProof(db, { stayId: s.stayId, action: a, actorId: x.actorId ?? s.providerId, idempotencyKey: nextKey("PA"), ...x });
  await show("finalize wrong token", () => act("sandbox_finalize_media", { mediaRef: g?.mediaRef ?? g?.mediaId ?? g?.id, uploadToken: "wrong", storageObjectId: "obj-1" }));
  await show("mime pdf", () => proof.prepareBoardingMedia(db, { stayId: s.stayId, action: "prepare_media", actorId: s.providerId, idempotencyKey: nextKey("PM"), purpose: "stay_update", mimeType: "application/pdf", sizeBytes: 100, sha256: "a".repeat(64) }));
  await show("bad sha", () => proof.prepareBoardingMedia(db, { stayId: s.stayId, action: "prepare_media", actorId: s.providerId, idempotencyKey: nextKey("PM"), purpose: "stay_update", mimeType: "image/jpeg", sizeBytes: 100, sha256: "nope" }));
  await show("medication", () => act("record_medication", { medicationName: "Amoxicillin", dose: "250mg", administeredAt: new Date().toISOString() }));
  await show("ack own incident", async () => { const r = await act("report_incident", { severity: "urgent", summary: "limping", actionTaken: "rested" }); console.log("PROBE incident", JSON.stringify(r)); return act("acknowledge_incident", { incidentId: r.incidentId, actorId: s.providerId }); });
});
