import { normalizeIndianMobile } from "./sms-test-provider";
export function validateCrmLead(value: unknown): { ok: true; name: string; phone: string } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "A valid lead object is required" };
  const body = value as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
  if (name.length < 2 || name.length > 80) return { ok: false, error: "Customer name must contain 2 to 80 characters" };
  const input = typeof body.primaryPhone === "string" ? body.primaryPhone.trim() : "";
  const phone = /^[+\d\s()-]+$/.test(input) ? normalizeIndianMobile(input) : null;
  if (!phone) return { ok: false, error: "Enter a valid 10-digit Indian mobile number, optionally prefixed with +91" };
  return { ok: true, name, phone };
}
