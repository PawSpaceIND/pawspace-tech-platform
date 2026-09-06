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

// This test used to pin the adapter's literal source: `if (!apiKey) { return { connected: false`,
// a fixed model string, and a sentence from a comment. Hardening the adapter broke all three while
// the fail-closed behaviour they were meant to protect was strictly better than before - which is the
// whole problem with proving behaviour by grepping formatting. What survives here is the one genuine
// source contract (a single named secret is the switch, and nothing local generates text in its
// place); the behaviour itself is executed in tests/ai-provider-adapter-execution.test.mjs.
test("AI activation is a single, reversible, fail-safe key switch", () => {
  assert.match(adapter, /PAWSPACE_AI_PROVIDER_API_KEY/);
  // The switch stays exactly one credential. Counting occurrences would break on formatting, so this
  // pins the SET of environment names the adapter reads: a second credential name is a second switch,
  // and a second switch is how "AI is off" stops being a single reversible fact.
  const envNames = [...new Set([...adapter.matchAll(/"(PAWSPACE_[A-Z_0-9]+|[A-Z_0-9]*API_KEY|[A-Z_0-9]*TOKEN|[A-Z_0-9]*SECRET)"/g)].map(m => m[1]))].sort();
  assert.deepEqual(envNames, ["PAWSPACE_AI_PROVIDER_API_KEY", "PAWSPACE_AI_PROVIDER_MODEL", "PAWSPACE_AI_PROVIDER_TIMEOUT_MS"],
    `the adapter reads ${envNames.join(", ")}; only the first is a credential and there must be no other`);
  assert.match(adapter, /https:\/\/api\.anthropic\.com\/v1\/messages/);
  assert.match(adapter, /"x-api-key": apiKey/);
  // No local generation: an offline fallback string would make a silent provider look like an answer.
  assert.doesNotMatch(adapter, /connected: true,\s*text: "/, "the adapter must never return text it made up itself");
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
