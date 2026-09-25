import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {importLibModule} from "./helpers/ts-module-loader.mjs";
const home=fs.readFileSync(new URL("../app/v2/page.tsx",import.meta.url),"utf8");
const chat=fs.readFileSync(new URL("../app/v2/chat/page.tsx",import.meta.url),"utf8");
test("V2 AI continuity regression executes governed callback classifier",async()=>{const {isCustomerCallbackRequest}=await importLibModule("ai-first-control-plane");assert.equal(isCustomerCallbackRequest("Please call me back"),true);assert.equal(isCustomerCallbackRequest("Tell me about grooming"),false);});
test("V2 home routes every AI entry into native V2 chat",()=>{assert.equal((home.match(/href="\/v2\/chat"/g)||[]).length,4);assert.doesNotMatch(home,/href="\/chat"/);});
test("V2 chat reuses governed AI and identity contracts",()=>{assert.match(chat,/\/api\/identity-session/);assert.match(chat,/\/api\/ai-web-chat/);assert.match(chat,/idempotencyKey:"v2-web-"/);});
test("authenticated chat fails closed without customer identity",()=>{assert.match(chat,/mode==="authenticated"&&identity!=="customer"/);assert.match(chat,/Open V2 home/);});

test("public V2 chat uses conversational AI path instead of raw knowledge dump",()=>{assert.match(chat,/sessionKey:publicSessionKey/);assert.match(chat,/history/);assert.match(chat,/Ask PawSpace AI/);assert.doesNotMatch(chat,/knowledge\.map/);});

test("public V2 chat grounds answers in the canonical service catalogue",()=>{const adapter=fs.readFileSync(new URL("../lib/ai-web-chat-adapter.ts",import.meta.url),"utf8");assert.match(adapter,/canonicalCatalogueSnapshot/);assert.match(adapter,/currentServiceCatalogue/);});

test("My PawSpace reads the conversation back so replies from the PawSpace team appear",()=>{assert.match(chat,/\/api\/ai-web-chat\?mode=thread/);assert.match(chat,/PawSpace team/);assert.match(chat,/TEAM_POLL_MS/);assert.doesNotMatch(chat,/setTimeout\(\(\)=>controller\.abort\(\),20000\)/,"the browser must wait longer than the server's model deadline");});

test("the Inbox & AI workspace replies to, takes over and resumes web chat on the web chat paths",()=>{const inbox=fs.readFileSync(new URL("../app/team/customer-experience/page.tsx",import.meta.url),"utf8");assert.match(inbox,/"\/api\/chat-human-reply", \{ action: "human_reply"/);assert.match(inbox,/action: "take_over", startIfIdle: true/);assert.match(inbox,/action: "resume_ai"/);assert.match(inbox,/\["chat", "Web chat"\]/);});
