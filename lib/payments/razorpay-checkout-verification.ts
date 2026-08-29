import { resolveRazorpayRuntime } from "./razorpay-runtime";

type Env = Record<string, unknown>;
const RAZORPAY_API = "https://api.razorpay.com";

function hex(bytes: ArrayBuffer) { return Array.from(new Uint8Array(bytes)).map(byte => byte.toString(16).padStart(2, "0")).join(""); }
function constantTimeEqual(a: string, b: string) { if (a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0; }

export async function verifyRazorpayCheckout(env: Env, input: { orderId: string; paymentId: string; signature: string; amountSubunits: number; currency: string }) {
  const runtime = resolveRazorpayRuntime(env);
  if (!runtime.configured) throw new Error(`Razorpay ${runtime.environment} credentials are not configured`);
  if (!input.orderId.startsWith("order_") || !input.paymentId.startsWith("pay_") || !/^[a-f0-9]{64}$/i.test(input.signature)) throw new Error("Razorpay checkout proof is malformed");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(runtime.keySecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${input.orderId}|${input.paymentId}`)));
  if (!constantTimeEqual(expected.toLowerCase(), input.signature.toLowerCase())) throw new Error("Razorpay checkout signature verification failed");

  const response = await fetch(`${RAZORPAY_API}/v1/payments/${encodeURIComponent(input.paymentId)}`, {
    method: "GET",
    headers: { authorization: `Basic ${btoa(`${runtime.keyId}:${runtime.keySecret}`)}` },
    redirect: "error",
  });
  let body: Record<string, unknown> = {};
  try { const parsed = await response.json(); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>; } catch {}
  if (!response.ok) throw new Error(`Razorpay payment verification failed (${response.status})`);
  if (String(body.id || "") !== input.paymentId || String(body.order_id || "") !== input.orderId) throw new Error("Razorpay payment does not belong to this order");
  if (String(body.status || "") !== "captured") throw new Error(`Razorpay payment is ${String(body.status || "not captured")}`);
  if (Number(body.amount || 0) !== input.amountSubunits || String(body.currency || "") !== input.currency) throw new Error("Razorpay captured amount or currency does not match the canonical order");
  return { environment: runtime.environment, payment: body };
}
