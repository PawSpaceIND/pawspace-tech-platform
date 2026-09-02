import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertBackupTarget } from "../scripts/d1-backup.mjs";
import { assertManifestChecksum, assertRestoreTarget } from "../scripts/d1-restore.mjs";

const PROD="11111111-1111-4111-8111-111111111111";
const STAGE="22222222-2222-4222-8222-222222222222";

function noMutation(fn){let mutated=false;const mutate=()=>{mutated=true;};return Promise.resolve().then(()=>fn(mutate)).then(()=>{assert.equal(mutated,false,"guard completed before any mutation");},error=>{assert.equal(mutated,false,"failure happened before any mutation");throw error;});}

test("backup rejects an unknown environment before export", async()=>{
 await assert.rejects(()=>noMutation(()=>assertBackupTarget({environment:"preview",databaseName:"pawspace-staging",databaseId:STAGE,productionId:PROD,stagingId:STAGE})),/environment must be production or staging/);
});

test("backup rejects a staging database id that does not match STAGING_D1_ID before export", async()=>{
 await assert.rejects(()=>noMutation(()=>assertBackupTarget({environment:"staging",databaseName:"pawspace-staging",databaseId:PROD,productionId:PROD,stagingId:STAGE})),/does not match STAGING_D1_ID/);
});

test("backup rejects a production database id that does not match PRODUCTION_D1_ID before export", async()=>{
 await assert.rejects(()=>noMutation(()=>assertBackupTarget({environment:"production",databaseName:"pawspace-prod-bengaluru",databaseId:STAGE,productionId:PROD,stagingId:STAGE})),/does not match PRODUCTION_D1_ID/);
});

test("backup rejects environment isolation collapse before export", async()=>{
 await assert.rejects(()=>noMutation(()=>assertBackupTarget({environment:"production",databaseName:"pawspace-prod-bengaluru",databaseId:PROD,productionId:PROD,stagingId:PROD})),/must be isolated/);
});

test("restore rejects an unknown environment before import", async()=>{
 await assert.rejects(()=>noMutation(()=>assertRestoreTarget({environment:"preview",databaseName:"pawspace-staging",databaseId:STAGE,productionId:PROD,stagingId:STAGE,confirm:"anything"})),/environment must be staging or production/);
});

test("staging restore refuses the production D1 id before import", async()=>{
 await assert.rejects(()=>noMutation(()=>assertRestoreTarget({environment:"staging",databaseName:"pawspace-staging",databaseId:PROD,productionId:PROD,stagingId:STAGE,confirm:`RESTORE-STAGING:pawspace-staging:${PROD}`})),/production D1 id/);
});

test("staging restore requires the exact database-specific confirmation before import", async()=>{
 await assert.rejects(()=>noMutation(()=>assertRestoreTarget({environment:"staging",databaseName:"pawspace-staging",databaseId:STAGE,productionId:PROD,stagingId:STAGE,confirm:"restore"})),/Missing exact staging confirmation/);
});

test("production restore needs both break-glass flag, protected token and exact confirmation", async()=>{
 await assert.rejects(()=>noMutation(()=>assertRestoreTarget({environment:"production",databaseName:"pawspace-prod-bengaluru",databaseId:PROD,productionId:PROD,stagingId:STAGE,confirm:`RESTORE-PRODUCTION:pawspace-prod-bengaluru:${PROD}`,breakGlass:true,breakGlassToken:"wrong"})),/break-glass/);
});

test("checksum mismatch fails before any restore mutation", async()=>{
 const dir=mkdtempSync(join(tmpdir(),"pawspace-d1-")),sql=join(dir,"snapshot.sql");writeFileSync(sql,"CREATE TABLE x(id TEXT);\n");
 const manifest={version:1,immutable:true,sha256:"0".repeat(64)};
 await assert.rejects(()=>noMutation(()=>assertManifestChecksum(manifest,sql)),/checksum mismatch/);
});

test("valid staging target and checksum guards pass",()=>{
 assert.equal(assertRestoreTarget({environment:"staging",databaseName:"pawspace-staging",databaseId:STAGE,productionId:PROD,stagingId:STAGE,confirm:`RESTORE-STAGING:pawspace-staging:${STAGE}`}),true);
 const dir=mkdtempSync(join(tmpdir(),"pawspace-d1-")),sql=join(dir,"snapshot.sql");writeFileSync(sql,"CREATE TABLE x(id TEXT);\n");
 const hash=createHash("sha256").update(Buffer.from("CREATE TABLE x(id TEXT);\n")).digest("hex");
 assert.equal(assertManifestChecksum({version:1,immutable:true,sha256:hash},sql),hash);
});
