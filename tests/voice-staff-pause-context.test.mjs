import test from "node:test";
import assert from "node:assert/strict";
import {voiceStaffPauseMessage} from "../lib/voice-staff-pause.ts";
for(const service of ["funeral","grooming"]){
 test(`${service} handoff details do not invent a refund concern`,()=>{
  for(const status of ["queued","staff_active"]){
   const reply=voiceStaffPauseMessage(`What details does the team need before the ${service} handoff?`,status,"service_request");
   assert.doesNotMatch(reply,/refund|amount/i);
   assert.match(reply,/service details/);
   assert.match(reply,/can't confirm availability or a booking/);
  }
 });
}
test("refund preparation remains specific to a recorded or requested refund",()=>{
 for(const [input,reason] of [["What details does the team need?","refund_review"],["What information does the team need for my refund?","service_request"]])assert.match(voiceStaffPauseMessage(input,"queued",reason),/teammate must decide any refund/);
});
