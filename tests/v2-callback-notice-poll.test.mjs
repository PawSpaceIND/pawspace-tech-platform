import test from "node:test";
import assert from "node:assert/strict";
import {installWorkersHooks} from "./helpers/module-hooks.mjs";
installWorkersHooks("__CALLBACK_NOTICE_POLL_DB__");
const {withCallbackNotices}=await import("../lib/v2/callback-notices.ts");
const notice={threadId:"thread-a",message:{id:"callback-notice-request-a",role:"bot",text:"Scheduling is not available. Open the customer app to contact the PawSpace team.",createdAt:20,author:null}};
const initial={threadId:"thread-a",messages:[{id:"request-a",role:"customer",text:"Call me tomorrow",createdAt:10}],handoff:{active:false,status:null}};

test("callback notice survives repeated server polls and later team replies",()=>{
 const first=withCallbackNotices(initial,[notice]);
 const polled=withCallbackNotices({...initial,messages:[...initial.messages,{id:"team-a",role:"team",text:"We can help",createdAt:30}],handoff:{active:true,status:"staff_active"}},[notice]);
 assert.equal(first.messages[1].text,notice.message.text);
 assert.deepEqual(polled.messages.map(message=>message.id),["request-a","callback-notice-request-a","team-a"]);
 assert.equal(withCallbackNotices(polled,[notice]).messages.filter(message=>message.id===notice.message.id).length,1);
 assert.equal(polled.handoff.status,"staff_active");
 assert.doesNotMatch(polled.messages[1].text,/queued|scheduled|connected|has been asked/i);
 assert.deepEqual(initial.messages.map(message=>message.id),["request-a"]);
});

test("polling another conversation cannot import a prior customer callback notice",()=>{
 const other={threadId:"thread-b",messages:[],handoff:{active:false,status:null}};
 assert.equal(withCallbackNotices(other,[notice]),other);
 const restored=withCallbackNotices(initial,[notice]);
 assert.equal(restored.messages.at(-1).text,notice.message.text);
});

test("V2 routes every transcript update through retained notices and captures response before polling",async()=>{
 const {readFileSync}=await import("node:fs");
 const page=readFileSync(new URL("../app/v2/chat/page.tsx",import.meta.url),"utf8");
 assert.match(page,/setTranscript\(current=>\{[\s\S]*?withCallbackNotices\(updated,callbackNotices.current\)/);
 assert.match(page,/const updated=payload\?\.data\?\.transcript\|\|await loadTranscript\(\)/);
 assert.match(page,/threadId:updated.threadId,message:\{id,role:"bot",text:notice/);
 assert.match(page,/showTranscript\(updated\)/);
});
