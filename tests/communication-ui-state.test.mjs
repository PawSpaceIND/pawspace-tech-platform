import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {consentEvidenceLabel,customerChatResponseError,customerChatErrorMessage} from "../lib/communication-ui-state.ts";
test("missing or unknown consent never appears verified",()=>{
  for(const value of [undefined,null,{},"unexpected","constructor","__proto__","<script>bad</script>"])assert.doesNotMatch(consentEvidenceLabel(true,value),/verified|<script>/i);
  assert.equal(consentEvidenceLabel(false,"verified"),"Not available for this conversation");
  assert.match(consentEvidenceLabel(true,"opted_out"),/do not message/);
  assert.match(consentEvidenceLabel(true,"granted"),/reported.*server policy/);
});
test("chat errors never expose raw provider or transport details",()=>{
  assert.doesNotMatch(customerChatErrorMessage(new Error("HTTP 500 stack trace secret")),/HTTP|stack|secret/);
  for(const code of [400,401,403,429,500])assert.doesNotMatch(customerChatErrorMessage(customerChatResponseError(code)),/HTTP|500|403/);
  assert.match(customerChatErrorMessage(customerChatResponseError(401)),/sign in again/);
});
test("chat guards overlapping submits and uses safe error mapping",()=>{
  const source=readFileSync(new URL("../app/chat/page.tsx",import.meta.url),"utf8");
  // The overlapping-submit guard here is a busy flag plus an abortable in-flight
  // request, rather than a sending ref; both halves have to stay.
  assert.match(source,/if\(busy\|\|/);
  assert.match(source,/setBusy\(true\)/);
  assert.match(source,/request\.current=controller/);
  // Safe error mapping: no server-provided text may reach the screen.
  assert.doesNotMatch(source,/payload\??\.error|cause\.message/);
  assert.ok(source.includes("customerChatResponseError(response.status)"));
  assert.ok(source.includes("customerChatErrorMessage(cause)"));
});
