import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { makeD1 } from "./helpers/ai-harness.mjs";

const { resolveExplicitAiKillSwitches } = await import("../lib/ai-runtime-kill-switch.ts");

function fixture(){
 const sqlite=new DatabaseSync(":memory:");
 sqlite.exec("CREATE TABLE ai_kill_switches (scope_type TEXT NOT NULL,scope_key TEXT NOT NULL,disabled INTEGER NOT NULL,reason TEXT NOT NULL)");
 return{sqlite,db:makeD1(sqlite)};
}

const target={channel:"whatsapp",intent:"booking_create",provider:"anthropic",model:"claude-sonnet-4-6"};

test("explicit global, channel, intent, provider and model switches block the matching runtime",async()=>{
 const{sqlite,db}=fixture();
 for(const [type,key] of [["global","ai"],["channel","whatsapp"],["intent","booking_create"],["provider","anthropic"],["model","claude-sonnet-4-6"]])
  sqlite.prepare("INSERT INTO ai_kill_switches VALUES (?,?,1,?)").run(type,key,`${type} disabled`);
 const matches=await resolveExplicitAiKillSwitches(db,target);
 assert.deepEqual(new Set(matches.map(item=>item.scopeType)),new Set(["global","channel","intent","provider","model"]));
});

test("unrelated and enabled switches do not block the runtime",async()=>{
 const{sqlite,db}=fixture();
 sqlite.prepare("INSERT INTO ai_kill_switches VALUES ('channel','voice',1,'voice disabled')").run();
 sqlite.prepare("INSERT INTO ai_kill_switches VALUES ('model','other-model',1,'other disabled')").run();
 sqlite.prepare("INSERT INTO ai_kill_switches VALUES ('provider','anthropic',0,'enabled')").run();
 assert.deepEqual(await resolveExplicitAiKillSwitches(db,target),[]);
});
