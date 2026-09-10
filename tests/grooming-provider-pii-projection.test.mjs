import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeProviderEventDetail,
  projectProviderLifecycleEvent,
  projectProviderLifecycleBundle,
} from "../lib/grooming-provider-projection.ts";

test("sanitizeProviderEventDetail drops phone, email and free-text address notes", () => {
  const detail = sanitizeProviderEventDetail({
    action: "arrived",
    providerId: "groom_blr",
    distanceMeters: 12,
    note: "called customer on +919812345678",
    email: "meera.subject@example.com",
    address: "12th Main, Indiranagar",
    checklist: ["coat", "nails"],
  });
  assert.equal(detail.action, "arrived");
  assert.equal(detail.providerId, "groom_blr");
  assert.equal(detail.distanceMeters, 12);
  assert.deepEqual(detail.checklist, ["coat", "nails"]);
  assert.equal(detail.note, undefined);
  assert.equal(detail.email, undefined);
  assert.equal(detail.address, undefined);
});

test("projectProviderLifecycleEvent never returns staff actor email", () => {
  const event = projectProviderLifecycleEvent({
    event_type: "service_completed",
    entity_type: "booking",
    actor_id: "ops@pawspace.in",
    detail_json: JSON.stringify({
      action: "complete",
      providerId: "groom_blr",
      note: "customer phone +919999999999",
    }),
    occurred_at: 1,
  });
  assert.equal(event.actorId, "provider_or_system");
  assert.equal(event.detail.action, "complete");
  assert.equal(event.detail.note, undefined);
});

test("projectProviderLifecycleBundle strips unbounded booking and payment blobs", () => {
  const projected = projectProviderLifecycleBundle({
    booking: {
      id: "B1",
      status: "completed",
      service_code: "grooming",
      package_code: "dog-basic",
      package_name: "Bath",
      city_id: "blr",
      zone_id: "blr-core",
      scheduled_start: "2026-09-10T10:00:00.000Z",
      scheduled_end: "2026-09-10T12:00:00.000Z",
      total_amount: 1899,
      currency: "INR",
      provider_id: "groom_blr",
      customer_id: "C1",
      work_order_id: "W1",
      work_order_status: "completed",
      payment_status: "captured",
      payment_method: "upi",
      payment_mode: "prepaid",
      amount: 1899,
      amount_due_now: 0,
      pricing_json: JSON.stringify({ secretStaffNote: "do not leak" }),
      created_by: "staff@pawspace.in",
    },
    proof: {
      before_photo_ref: "media://a",
      after_photo_ref: "media://b",
      checklist_json: '["coat"]',
      completion_notes: "ok",
      updated_at: 2,
    },
    invoice: { invoice_number: "INV-1", status: "issued", net_amount: 1899, issued_at: 3 },
    subscriptionUsage: null,
    repeatTask: null,
    taxReadiness: null,
    payoutReadiness: null,
    events: [
      {
        event_type: "service_completed",
        entity_type: "booking",
        actor_id: "staff@pawspace.in",
        detail_json: JSON.stringify({ action: "complete", note: "called on +911234567890" }),
        occurred_at: 4,
      },
    ],
  });
  assert.equal(projected.booking.id, "B1");
  assert.equal(projected.booking.created_by, undefined);
  assert.equal(projected.booking.pricing_json, undefined);
  assert.equal(projected.events[0].actorId, "provider_or_system");
  assert.equal(projected.events[0].detail.note, undefined);
  assert.equal(projected.proof.beforePhotoRef, "media://a");
});
