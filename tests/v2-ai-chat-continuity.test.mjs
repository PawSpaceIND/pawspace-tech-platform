import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const home=fs.readFileSync(new URL("../app/v2/page.tsx",import.meta.url),"utf8");
const chat=fs.readFileSync(new URL("../app/v2/chat/page.tsx",import.meta.url),"utf8");
test("V2 home routes every AI entry into native V2 chat",()=>{assert.equal((home.match(/href="\/v2\/chat"/g)||[]).length,4);assert.doesNotMatch(home,/href="\/chat"/);});
test("V2 chat reuses governed AI and identity contracts",()=>{assert.match(chat,/\/api\/identity-session/);assert.match(chat,/\/api\/ai-web-chat/);assert.match(chat,/idempotencyKey:"v2-web-"/);});
test("authenticated chat fails closed without customer identity",()=>{assert.match(chat,/mode==="authenticated"&&identity!=="customer"/);assert.match(chat,/Open V2 home/);});
