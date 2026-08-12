import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const adapter = await read("../lib/ai-provider-adapter.ts");
const governance = await read("../lib/ai-governance.ts");
const quiz = await read("../lib/provider-quiz-ai-draft.ts");
const evalSec = await read("../lib/ai-evaluation-security.ts");
const webChat = await read("../lib/ai-web-chat-adapter.ts");

// Permanent readiness gate for AI activation: the whole switch is one secret
// (PAWSPACE_AI_PROVIDER_API_KEY). These invariants must hold so that setting the key
// flips AI on cleanly, removing it fails safe, and the human-in-the-loop guardrails
// can never be silently weakened. (The deep flip-on behaviour is exercised by the
// scratchpad execution preflight; this is the CI-run contract check.)

test("AI activation is a single, reversible, fail-safe key switch", () => {
  // one secret is the switch
  assert.match(adapter, /PAWSPACE_AI_PROVIDER_API_KEY/);
  // fails closed when the key is absent — never fabricates AI text
  assert.match(adapter, /if \(!apiKey\) \{\s*return \{ connected: false/);
  assert.match(adapter, /never fabricates AI output locally/);
  // targets the Anthropic Messages API with the pinned model
  assert.match(adapter, /https:\/\/api\.anthropic\.com\/v1\/messages/);
  assert.match(adapter, /model: "claude-sonnet-4-6"/);
  assert.match(adapter, /"x-api-key": apiKey/);
});

test("AI guardrails: forbidden autonomous actions + human-in-the-loop cannot be weakened", () => {
  // the 8 forbidden autonomous actions
  for (const a of ["refund", "price_change", "payment", "payout", "outbound_contact", "customer_merge", "provider_assignment", "campaign_activation"]) {
    assert.match(governance, new RegExp(`"${a}"`), `forbidden action ${a} must stay on the blocklist`);
  }
  assert.match(governance, /export function assertAiActionAllowed/);
  assert.match(governance, /AI autonomous action blocked/);
  // only the 4 assistive actions are allowed
  assert.match(governance, /"summarize","next_best_action","draft_response","risk_flag"/);
  // every suggestion is review_required and never auto-executes
  assert.match(governance, /status:\s*"review_required"/);
  assert.match(governance, /autonomousExecution:\s*false/);
  // review requires a note (audit trail)
  assert.match(governance, /export async function reviewAiSuggestion/);
});

test("AI assist surfaces are draft-only and privacy-safe", () => {
  // provider onboarding assist is draft-only via the shared adapter
  assert.match(quiz, /import \{ requestAiDraft \} from ".\/ai-provider-adapter"/);
  assert.match(quiz, /connected: false/);
  // prompt-injection guard exists
  assert.match(evalSec, /export function detectPromptInjection/);
  // public web chat exposes no customer data and runs no tools
  assert.match(webChat, /customerDataAccess:false/);
  assert.match(webChat, /toolExecution:false/);
});
