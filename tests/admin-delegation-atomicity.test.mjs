import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PAWSPACE_TEST_DB__", "__PAWSPACE_TEST_ENV__");
const route=await import("../app/api/platform-governance/route.ts");

function makeD1(sqlite,state={failAudit:false}){
  const statement=(sql,args)=>({
    bind:(...bound)=>statement(sql,bound),
    first:async()=>{const row=sqlite.prepare(sql).get(...args);return row===undefined?null:row;},
    run:async()=>{if(state.failAudit&&/^\s*INSERT INTO security_audit_events/i.test(sql))throw new Error("injected audit failure");const info=sqlite.prepare(sql).run(...args);return{success:true,meta:{changes:Number(info.changes)}};},
    all:async()=>({results:sqlite.prepare(sql).all(...args)}),
  });
  return{
    prepare:(sql)=>statement(sql,[]),
    batch:async(list)=>{sqlite.exec("BEGIN");try{const out=[];for(const item of list)out.push(await item.run());sqlite.exec("COMMIT");return out;}catch(error){sqlite.exec("ROLLBACK");throw error;}},
    exec:async(sql)=>{sqlite.exec(sql);return{count:0,duration:0};},
  };
}

const ADMIN_EMAIL="admin.actor@tkpetcare.in";
function setup(state={failAudit:false}){
  const sqlite=new DatabaseSync(":memory:");
  globalThis.__PAWSPACE_TEST_DB__=makeD1(sqlite,state);
  globalThis.__PAWSPACE_TEST_ENV__={};
  sqlite.exec("CREATE TABLE app_users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role_code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE role_definitions (code TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,permissions_json TEXT NOT NULL,system_role INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL)");
  const insert=sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)");
  insert.run("U-ADMIN",ADMIN_EMAIL,"Admin Actor","admin","active",0,0);
  insert.run("U-STAFF","ordinary.staff@tkpetcare.in","Ordinary Staff","associate","active",0,0);
  return sqlite;
}

const post=(body)=>route.POST(new Request("https://control.pawspace.in/api/platform-governance",{method:"POST",headers:{"content-type":"application/json","oai-authenticated-user-email":ADMIN_EMAIL},body:JSON.stringify(body)}));
const roleOf=(sqlite,id)=>sqlite.prepare("SELECT role_code FROM app_users WHERE id=?").get(id)?.role_code;

test("admin cannot switch its own role to another non-wildcard privilege domain",async()=>{
  const sqlite=setup();
  const response=await post({action:"update_user",id:"U-ADMIN",roleCode:"finance",status:"active"});
  assert.equal(response.status,403);
  assert.equal(roleOf(sqlite,"U-ADMIN"),"admin");
  const denial=sqlite.prepare("SELECT detail_json FROM security_audit_events WHERE action='update_user' AND outcome='denied' ORDER BY created_at DESC LIMIT 1").get();
  assert.match(String(denial?.detail_json),/self_role_change_blocked/);
});

test("admin cannot delegate a role containing grants outside the admin active grant set",async()=>{
  const sqlite=setup();
  const response=await post({action:"update_user",id:"U-STAFF",roleCode:"finance",status:"active"});
  assert.equal(response.status,403);
  assert.equal(roleOf(sqlite,"U-STAFF"),"associate");
  const denial=sqlite.prepare("SELECT detail_json FROM security_audit_events WHERE action='update_user' AND outcome='denied' ORDER BY created_at DESC LIMIT 1").get();
  assert.match(String(denial?.detail_json),/delegation_exceeds_actor_grants/);
});

test("audit insert failure rolls back the user role mutation",async()=>{
  const state={failAudit:false};const sqlite=setup(state);
  state.failAudit=true;
  const response=await post({action:"update_user",id:"U-STAFF",roleCode:"associate",status:"suspended"});
  assert.equal(response.status,500);
  const row=sqlite.prepare("SELECT role_code,status FROM app_users WHERE id='U-STAFF'").get();
  assert.equal(row.role_code,"associate");
  assert.equal(row.status,"active","state update must roll back when its audit statement fails");
});
