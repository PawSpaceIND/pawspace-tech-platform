import test from "node:test";
import assert from "node:assert/strict";
import { voiceTaxiIntakeExplanation } from "../lib/voice-conversation-style.mjs";
test("common Taxi explanation includes only the first intake group",()=>{
 const reply=voiceTaxiIntakeExplanation('How does your pet taxi service work, and what pickup information would you need?');
 assert.match(reply,/pickup and drop addresses/);assert.match(reply,/preferred date and time/);
 assert.doesNotMatch(reply,/luggage|passenger|waiting|one-way|return/);
 assert.ok(reply.split(/\s+/).length<=40);
});
test("price, exhaustive details, incidents and action requests cannot use the short Taxi explanation",()=>{
 for(const query of ['What does your pet taxi fare cost?','How does pet taxi work and book it for tomorrow?','How does pet taxi work for an emergency?','Tell me every detail of how pet taxi works.','How does pet taxi work and can I cancel my booking?','How does grooming work?','How does pet taxi work for my injured pet?','How does pet taxi work? Hindi please.','How does pet taxi work? हिंदी में बताएं','How does pet taxi work after my pet passed away?'])assert.equal(voiceTaxiIntakeExplanation(query),null,query);
});
