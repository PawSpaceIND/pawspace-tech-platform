import { ingestInboundEmail, recordEmailEngagement, syncCalendarEvents } from "../../../lib/crm-email-sync";

type Env = { DB: D1Database; PAWSPACE_EMAIL_WEBHOOK_SECRET?: string };
const text = (v: unknown) => String(v ?? "").trim();
const encoder = new TextEncoder();

async function runtimeEnv(): Promise<Env> {
  const { env } = await import("cloudflare:workers");
  return env as unknown as Env;
}
function hex(bytes: ArrayBuffer) { return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join(""); }
function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0;
}
async function verifySignature(raw: string, secret: string, supplied: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, encoder.encode(raw)));
  const normalized = supplied.toLowerCase().replace(/^sha256=/, "");
  return constantTimeEqual(expected, normalized);
}

export async function POST(request: Request) {
  try {
    const env = await runtimeEnv(), secret = text(env.PAWSPACE_EMAIL_WEBHOOK_SECRET);
    if (!secret) return Response.json({ ok: false, error: "email_webhook_not_configured" }, { status: 503 });
    const raw = await request.text(), signature = text(request.headers.get("x-pawspace-email-signature") || request.headers.get("x-signature"));
    if (!signature || !(await verifySignature(raw, secret, signature))) return Response.json({ ok: false, error: "invalid_signature" }, { status: 401 });
    const body = JSON.parse(raw) as Record<string, unknown>, provider = text(body.provider) || "email_provider", eventType = text(body.eventType || body.type);
    if (eventType === "inbound") {
      const result = await ingestInboundEmail(env.DB, {
        provider, providerEventId: text(body.eventId), providerMessageId: text(body.messageId), from: text(body.from), to: text(body.to), subject: text(body.subject), textBody: text(body.text || body.body), receivedAt: body.occurredAt == null ? undefined : Number(body.occurredAt),
      });
      return Response.json({ ok: true, result });
    }
    if (["delivered", "open", "click", "bounce", "complaint"].includes(eventType)) {
      const result = await recordEmailEngagement(env.DB, { provider, providerEventId: text(body.eventId), providerMessageId: text(body.messageId), eventType: eventType as "delivered" | "open" | "click" | "bounce" | "complaint", occurredAt: body.occurredAt == null ? undefined : Number(body.occurredAt), detail: (body.detail || {}) as Record<string, unknown> });
      return Response.json({ ok: true, result });
    }
    if (eventType === "calendar_sync") {
      const events = Array.isArray(body.events) ? body.events as Array<{ id: string; attendeeEmail?: string; title: string; startAt: number; endAt: number; status?: string; detail?: Record<string, unknown> }> : [];
      return Response.json({ ok: true, result: await syncCalendarEvents(env.DB, { provider, events }) });
    }
    return Response.json({ ok: false, error: "unsupported_event" }, { status: 400 });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "email_webhook_error" }, { status: 400 });
  }
}
