// Real-provider configuration proof only. Never starts a conversation or phone call.
import { pathToFileURL } from "node:url";
const OPENAI = "https://api.openai.com/v1/responses";
const ELEVENLABS = "https://api.elevenlabs.io";
// ElevenLabs stores the base URL; its Responses transport appends /responses.
const AGENT_ENDPOINT = "https://pawspace-staging.karthik-fce.workers.dev/api/elevenlabs/v1";
const MODEL = "gpt-5.6-luna";
async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing_body");
  const decoder = new TextDecoder(); let size = 0, text = "";
  try { for (;;) { const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength; if (size > 512 * 1024) { await reader.cancel(); throw new Error("oversized_body"); }
    text += decoder.decode(value, { stream: true });
  } return JSON.parse(text + decoder.decode()); } finally { reader.releaseLock(); }
}
export async function providerPreflight(env, fetcher = fetch) {
  const output = { callsPlaced: 0, conversationsStarted: 0, customerDataSent: false,
    testType: "synthetic_provider_preflight", regionTested: "global", productionReady: false,
    openai: { configured: Boolean(env.PAWSPACE_OPENAI_API_KEY), verified: false, modelRequested: MODEL },
    elevenlabs: { configured: Boolean(env.ELEVENLABS_API_KEY && env.ELEVENLABS_AGENT_ID), verified: false } };
  if (output.openai.configured) {
    try {
      const r = await fetcher(OPENAI, { method: "POST", signal: AbortSignal.timeout(25000), redirect: "error",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.PAWSPACE_OPENAI_API_KEY}` },
        body: JSON.stringify({ model: MODEL, instructions: "Return only OK.", input: "Synthetic connectivity check. No business action.",
          max_output_tokens: 128, reasoning: { effort: "none" }, store: false }) });
      output.openai.httpStatus = r.status;
      if (!r.ok) { await r.body?.cancel(); output.openai.reason = "provider_request_rejected"; }
      else { const body = await boundedJson(r);
        const text = typeof body.output_text === "string" ? body.output_text : (body.output || []).flatMap(x => x.content || []).filter(x => x.type === "output_text").map(x => x.text || "").join("");
        output.openai.verified = body.status === "completed" && text.trim() === "OK";
        output.openai.reason = output.openai.verified ? "synthetic_reply_verified" : "unexpected_synthetic_reply";
      }
    } catch { output.openai.reason = "bounded_provider_probe_failed"; }
  }
  if (output.elevenlabs.configured) {
    try {
      const agentId = String(env.ELEVENLABS_AGENT_ID);
      if (!/^agent_[A-Za-z0-9_-]{1,120}$/.test(agentId)) throw new Error("invalid_agent_id");
      const r = await fetcher(`${ELEVENLABS}/v1/convai/agents/${encodeURIComponent(agentId)}`, {
        method: "GET", signal: AbortSignal.timeout(25000), redirect: "error", headers: { "xi-api-key": env.ELEVENLABS_API_KEY } });
      output.elevenlabs.httpStatus = r.status;
      if (!r.ok) { await r.body?.cancel(); output.elevenlabs.reason = "agent_read_rejected"; }
      else { const body = await boundedJson(r), prompt = body.conversation_config?.agent?.prompt;
        output.elevenlabs.verified = body.agent_id === agentId;
        output.elevenlabs.customLlmEndpointMatches = prompt?.custom_llm?.url === AGENT_ENDPOINT;
        output.elevenlabs.responsesApiSelected = prompt?.custom_llm?.api_type === "responses";
        output.elevenlabs.serverSideLlmAuthConfigured = Boolean(prompt?.custom_llm?.api_key);
        output.elevenlabs.attachedPhoneNumbers = Array.isArray(body.phone_numbers) ? body.phone_numbers.length : 0;
        output.elevenlabs.reason = output.elevenlabs.verified ? "agent_read_verified_not_conversation_proof" : "agent_identity_mismatch";
      }
    } catch { output.elevenlabs.reason = "bounded_agent_read_failed"; }
  }
  output.configurationVerified = providerPreflightPassed(output);
  return output;
}
export function providerPreflightPassed(result) {
  return result.openai.verified === true && result.elevenlabs.verified === true
    && result.elevenlabs.customLlmEndpointMatches === true
    && result.elevenlabs.responsesApiSelected === true
    && result.elevenlabs.serverSideLlmAuthConfigured === true;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await providerPreflight(process.env);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = providerPreflightPassed(result) ? 0 : 1;
}
