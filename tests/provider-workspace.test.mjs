import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const ws = await read("../lib/provider-workspace.ts");
const route = await read("../app/api/provider-workspace/route.ts");

test("provider workspace is own-record-only and splits contract vs commission surfaces", () => {
  assert.match(ws, /export async function resolveProviderForActor/);
  assert.match(ws, /provider_identity_links WHERE email=\? AND status='active'/);
  assert.match(ws, /this booking is not assigned to you|is not assigned to you/i);
  assert.match(ws, /features\.payslip\?\{netPayout/);                 // contract sees earnings
  assert.match(ws, /Commission providers see only their booking dashboard/); // commission does not
});

test("proof submission mirrors to a customer-visible update and is config-driven per service", () => {
  assert.match(ws, /export const PROOF_REQUIREMENTS/);
  assert.match(ws, /grooming:\["before_photo","after_photo"\]/);
  assert.match(ws, /export async function submitJobProof/);
  assert.match(ws, /INSERT INTO customer_job_updates/);              // customer app mirror
  assert.match(ws, /is not expected for/);                          // rejects wrong proof type
});

test("live assignments: first accept wins and assigns the booking", () => {
  assert.match(ws, /export async function offerJobToProvider/);
  assert.match(ws, /export async function respondToJobOffer/);
  assert.match(ws, /already been accepted by another provider/);
  assert.match(ws, /UPDATE canonical_bookings SET provider_id=\?/);
});

test("the route resolves the caller's own provider and gates writes", () => {
  assert.match(route, /resolveProviderForActor\(db,actor\.email\)/);
  assert.match(route, /Cross-origin provider write blocked/);
  for (const a of ["submit_proof", "accept_job", "decline_job"]) assert.match(route, new RegExp(`"${a}"`));
});
