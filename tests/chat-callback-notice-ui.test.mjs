/**
 * Chat-owned pages only. Reads app/chat/page.tsx and app/v2/chat/page.tsx as text.
 * Does not import shared libs, the route, or the voice engine.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const chat = readFileSync(join(root, "app/chat/page.tsx"), "utf8");
const v2 = readFileSync(join(root, "app/v2/chat/page.tsx"), "utf8");

function chatVisible(reply, mode) {
  const match = chat.match(/<p>\{(reply\.callbackNotice\?reply\.callbackNotice:[\s\S]*?)\}<\/p>/);
  assert.ok(match, "chat page must render callbackNotice / callbackOutcome in the answer");
  return Function("reply", "mode", `return ${match[1]}`)(reply, mode);
}

test("blocked or not_placed chat copy says no call was placed and does not claim the call is connected", () => {
  assert.match(chat, /callbackNotice\?:string;callbackOutcome\?:string/);
  const blocked = "The callback was not placed (blocked_opt_out). The PawSpace team has been asked to call you.";
  assert.equal(chatVisible({ callbackNotice: blocked, callbackOutcome: "not_placed" }, "authenticated"), blocked);
  assert.match(chatVisible({ callbackNotice: blocked, callbackOutcome: "not_placed" }, "authenticated"), /not placed/i);
  assert.match(chatVisible({ callbackNotice: blocked, callbackOutcome: "not_placed" }, "authenticated"), /team has been asked to call/i);
  assert.equal(chatVisible({ callbackOutcome: "not_placed" }, "authenticated"), "The callback was not placed.");
  const acceptedNotice = "The callback was accepted.";
  assert.equal(chatVisible({ callbackNotice: acceptedNotice, callbackOutcome: "accepted", callback: { matched: true } }, "authenticated"), acceptedNotice);
  assert.equal(chatVisible({ callback: { matched: true }, callbackOutcome: "accepted" }, "authenticated"), "Your callback request was received. This does not confirm that a call has been placed.");
  for (const text of [
    chatVisible({ callbackNotice: blocked, callbackOutcome: "not_placed" }, "authenticated"),
    chatVisible({ callbackOutcome: "not_placed" }, "authenticated"),
    chatVisible({ callbackNotice: acceptedNotice, callbackOutcome: "accepted", callback: { matched: true } }, "authenticated"),
    chatVisible({ callback: { matched: true }, callbackOutcome: "accepted" }, "authenticated"),
  ]) {
    assert.doesNotMatch(text, /connected/i);
  }
  assert.doesNotMatch(chat, /connected/i);
});

test("v2 chat shows the callback notice and does not say the call is connected", () => {
  assert.match(v2, /callbackNotice\?:string\|null;callbackOutcome\?:string\|null/);
  assert.match(v2, /if\(data\?\.callbackNotice\)next\.push\(\{id:localId\(\),side:"system",text:data\.callbackNotice\}\)/);
  assert.match(v2, /const notice=payload\?\.data\?\.callbackNotice\|\|\(payload\?\.data\?\.callbackOutcome==="unsupported_scheduling"\?"Scheduling is not available\. The PawSpace team has been asked to follow up\.":null\)/);
  assert.match(v2, /text:notice/);
  assert.doesNotMatch(v2, /connected/i);
  assert.doesNotMatch(v2, /call is connected|you're connected|you are connected/i);
});

test("unsupported scheduling says it is not available and the team will follow up", () => {
  const scheduling = "Scheduling is not available. The PawSpace team has been asked to follow up.";
  assert.equal(chatVisible({ callbackOutcome: "unsupported_scheduling" }, "authenticated"), scheduling);
  assert.equal(chatVisible({ callbackNotice: scheduling, callbackOutcome: "unsupported_scheduling" }, "authenticated"), scheduling);
  assert.match(scheduling, /scheduling is not available/i);
  assert.match(scheduling, /team has been asked to follow up/i);
  assert.doesNotMatch(scheduling, /queued|connected|dialling|dialing/);
  assert.doesNotMatch(scheduling, /\bscheduled\b/i);
  assert.match(chat, /callbackOutcome==='unsupported_scheduling'\?'Scheduling is not available\. The PawSpace team has been asked to follow up\.'/);
  assert.match(v2, /callbackOutcome==="unsupported_scheduling"/);
  assert.match(v2, /Scheduling is not available\. The PawSpace team has been asked to follow up\./);
  assert.doesNotMatch(v2, /connected/i);
});
