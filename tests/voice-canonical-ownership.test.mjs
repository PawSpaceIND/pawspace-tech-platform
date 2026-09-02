import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
installWorkersHooks("__VOICE_CANON_DB__", "__VOICE_CANON_ENV__");
const gov = await import("../lib/voice-outbound-governance.ts");

function dbWith(rows = {}) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => {
              if (sql.includes("lead_work_items")) return rows.lead ?? null;
              if (sql.includes("canonical_customers")) return rows.customer ?? null;
              throw new Error(`unexpected SQL ${sql}`);
            },
          };
        },
      };
    },
  };
}

test("voice ownership refuses an unknown canonical customer before policy/consent", async () => {
  await assert.rejects(() => gov.resolveCanonicalVoiceRecipient(dbWith(), { customerId: "C-404", phone: "9876543210" }), /Canonical customer not found/);
});

test("voice ownership refuses a caller-supplied number that is not the customer's stored phone", async () => {
  const db = dbWith({ customer: { primary_phone: "+919876543210", secondary_phone: null } });
  await assert.rejects(() => gov.resolveCanonicalVoiceRecipient(db, { customerId: "C-1", phone: "9000000001" }), /does not belong/);
});

test("lead-only voice resolves lead customer then canonical stored number", async () => {
  const db = dbWith({ lead: { customer_id: "C-1" }, customer: { primary_phone: "+91 98765 43210", secondary_phone: null } });
  const result = await gov.resolveCanonicalVoiceRecipient(db, { leadId: "L-1", phone: "9876543210" });
  assert.deepEqual(result, { customerId: "C-1", phone: "+91 98765 43210" });
});
