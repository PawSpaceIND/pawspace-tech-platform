import { managedAudioNoSend, MANAGED_AUDIO_PROFILE, MANAGED_AUDIO_CALL_PREFIX, isManagedAudioThread } from "./managed-audio-test-control";
type Env = Record<string, unknown>;
type Row = Record<string, unknown>;
const text = (value: unknown) => String(value ?? "").trim();
/** A test-isolation binding denies every other entry point; it never enables any transport. */
export async function managedAudioRequestBlock(request: Request, env: Env): Promise<Response | null> {
 if (!managedAudioNoSend(env)) return null;
 const refuse = () => Response.json({ error: "managed_audio_isolation_blocks_this_request" }, { status: 503, headers: { "cache-control": "no-store" } });
 if (text(env.PAWSPACE_MANAGED_AUDIO_ISOLATION) !== "no-send-v1" || text(env.PAWSPACE_DEPLOYMENT_ENV) !== "staging") return refuse();
 const url = new URL(request.url), path = url.pathname;
 if (request.method === "GET" && path === "/api/ai-voice-uat" && (url.searchParams.get("managedAudioCapability") === "1" || text(url.searchParams.get("callId")).startsWith(MANAGED_AUDIO_CALL_PREFIX))) return null;
 if (request.method !== "POST" || !["/api/staging-login", "/api/ai-voice-uat", "/api/elevenlabs/v1/responses"].includes(path)) return refuse();
 const length = Number(request.headers.get("content-length")); if (length > 64 * 1024) return refuse();
 let body: Row;
 try {
  // Bound streamed bodies too; Content-Length is not authority.
  const reader = request.clone().body?.getReader(); if (!reader) return refuse();
  const chunks: Uint8Array[] = []; let bytes = 0;
  for (;;) { const item = await reader.read(); if (item.done) break; bytes += item.value.byteLength; if (bytes > 64 * 1024) { void reader.cancel().catch(() => {}); return refuse(); } chunks.push(item.value); }
  const joined = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  body = JSON.parse(new TextDecoder().decode(joined)) as Row;
  if (!body || typeof body !== "object" || Array.isArray(body)) return refuse();
 } catch { return refuse(); }
 if (path === "/api/staging-login") return body.email === "founder@pawspace.in" ? null : refuse();
 if (path === "/api/ai-voice-uat") {
  const action = body.action ?? "start";
  if (action === "start") return body.managedAudioProfile === MANAGED_AUDIO_PROFILE && body.direction === "inbound" && body.transportProvider === "sandbox_simulator" ? null : refuse();
  return ["segment", "transfer", "transport_failure", "complete"].includes(text(action)) && text(body.callId).startsWith(MANAGED_AUDIO_CALL_PREFIX) ? null : refuse();
 }
 const extra = (body.elevenlabs_extra_body || body.metadata || {}) as Row;
 return isManagedAudioThread(text(extra.pawspace_thread_id)) && Boolean(text(extra.pawspace_customer_id)) && !text(extra.pawspace_voice_session_id) && !text(extra.pawspace_voice_call_id) ? null : refuse();
}
