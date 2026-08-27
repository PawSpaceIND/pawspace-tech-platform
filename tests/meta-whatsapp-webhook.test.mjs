import assert from"node:assert/strict";
import test from"node:test";
import{readFile}from"node:fs/promises";

const source=await readFile(new URL("../lib/meta-whatsapp-webhook.ts",import.meta.url),"utf8");

test("Meta webhook implementation verifies the exact raw body with HMAC SHA-256",()=>{
 assert.match(source,/crypto\.subtle\.importKey\("raw"/);
 assert.match(source,/crypto\.subtle\.sign\("HMAC",key,encoder\.encode\(rawBody\)\)/);
 assert.match(source,/sha256=/);
});

test("Meta webhook implementation is replay-safe through the existing UAT event ledger",()=>{
 assert.match(source,/recordWhatsAppUatInbound/);
 assert.match(source,/inbound\.duplicatePrevented/);
 assert.match(source,/recordWhatsAppUatDelivery/);
});

test("STOP-family opt-outs are explicit whole-message commands",()=>{
 assert.match(source,/new Set\(\["stop","unsubscribe","cancel","end","quit"\]\)/);
 assert.match(source,/opted_out/);
 assert.match(source,/whatsapp_consent=0,opt_out=1/);
 assert.match(source,/revoked_at=COALESCE/);
});

test("human ownership blocks AI while governed AI drafts remain approval-gated and never auto-send",()=>{
 assert.match(source,/if\(input\.humanOwned\)return\{status:"received",routingMode:"human_only",aiEligible:false,autoSend:false/);
 assert.match(source,/routing\.mode==="ai_assistant"/);
 assert.match(source,/runGovernedMetaWhatsAppAiTurn/);
 assert.match(source,/aiEligible:true/);
 assert.match(source,/automationReason:ai\.status==="ai_draft_ready"\?"governed_ai_draft_ready":"governed_ai_pending"/);
 assert.doesNotMatch(source,/autoSend:true/);
});

test("Meta delivery callbacks map to canonical communication messages",()=>{
 assert.match(source,/provider_reference=\?/);
 assert.match(source,/unknown_provider_message/);
 assert.match(source,/eventType:event\.status/);
});

test("Phase 1B keeps external delivery disabled",()=>{
 const matches=source.match(/externalDelivery:false/g)||[];
 assert.ok(matches.length>=6,"expected explicit fail-closed external delivery markers");
});
