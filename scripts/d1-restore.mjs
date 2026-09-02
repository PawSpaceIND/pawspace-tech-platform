import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i;
const text=v=>String(v??"").trim();
const sha256=path=>createHash("sha256").update(readFileSync(path)).digest("hex");
export function assertRestoreTarget({environment,databaseName,databaseId,productionId,stagingId,confirm,breakGlass=false,breakGlassToken=""}){
 if(!["staging","production"].includes(environment))throw new Error("Restore environment must be staging or production");
 if(!databaseName||!/^[a-zA-Z0-9_-]{3,80}$/.test(databaseName))throw new Error("A valid D1 database name is required");
 if(!UUID.test(databaseId))throw new Error("A valid D1 database id is required");
 if(productionId&&stagingId&&productionId===stagingId)throw new Error("Production and staging D1 ids must be isolated");
 if(environment==="staging"){
  if(productionId&&databaseId===productionId)throw new Error("Refusing to restore a staging snapshot into the production D1 id");
  if(stagingId&&databaseId!==stagingId)throw new Error("Restore target does not match STAGING_D1_ID");
  const expected=`RESTORE-STAGING:${databaseName}:${databaseId}`;if(confirm!==expected)throw new Error(`Missing exact staging confirmation: ${expected}`);
 }else{
  if(!productionId||databaseId!==productionId)throw new Error("Production restore target does not match PRODUCTION_D1_ID");
  if(!breakGlass||breakGlassToken!=="I_ACCEPT_PRODUCTION_D1_DATA_LOSS")throw new Error("Production restore requires the break-glass flag and protected token");
  const expected=`RESTORE-PRODUCTION:${databaseName}:${databaseId}`;if(confirm!==expected)throw new Error(`Missing exact production confirmation: ${expected}`);
 }
 return true;
}
export function assertManifestChecksum(manifest,sqlPath){if(!manifest||manifest.version!==1||manifest.immutable!==true)throw new Error("Unsupported or mutable D1 backup manifest");if(!/^[0-9a-f]{64}$/i.test(text(manifest.sha256)))throw new Error("Manifest checksum is invalid");const actual=sha256(sqlPath);if(actual!==text(manifest.sha256).toLowerCase())throw new Error("D1 backup checksum mismatch");return actual;}
function wrangler(args){const result=spawnSync(process.platform==="win32"?"npx.cmd":"npx",["wrangler",...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"]});if(result.status!==0)throw new Error(`wrangler ${args[0]} failed: ${text(result.stderr||result.stdout).slice(0,500)}`);return text(result.stdout);}
function jsonOutput(args){const raw=wrangler(args);try{return JSON.parse(raw);}catch{throw new Error(`wrangler ${args[0]} did not return JSON`);}}
function flattened(value,out=[]){if(Array.isArray(value))for(const x of value)flattened(x,out);else if(value&&typeof value==="object"){out.push(value);for(const x of Object.values(value))flattened(x,out);}return out;}
function infoIdentity(info){const rows=flattened(info);const id=rows.map(r=>text(r.uuid||r.id||r.database_id)).find(v=>UUID.test(v))||"";const name=rows.map(r=>text(r.name||r.database_name)).find(Boolean)||"";return{id,name};}
function queryRows(databaseName,sql){const result=jsonOutput(["d1","execute",databaseName,"--remote","--json","--command",sql]);return flattened(result).flatMap(r=>Array.isArray(r.results)?r.results:[]);}
function quoteIdent(name){if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))throw new Error(`Unsafe table name: ${name}`);return `"${name}"`;}
export function validateRestoredInventory(databaseName,tables){const actual=queryRows(databaseName,"SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");const byName=new Map(actual.map(row=>[text(row.name),row]));for(const expected of tables||[]){const row=byName.get(text(expected.name));if(!row)throw new Error(`Restored schema is missing table ${expected.name}`);const schemaHash=createHash("sha256").update(text(row.sql)).digest("hex");if(expected.schemaSha256&&schemaHash!==expected.schemaSha256)throw new Error(`Restored schema checksum differs for ${expected.name}`);const count=queryRows(databaseName,`SELECT COUNT(*) AS count FROM ${quoteIdent(text(expected.name))}`)[0];const rows=Number(count?.count??count?.COUNT??0);if(rows!==Number(expected.rows))throw new Error(`Restored row count differs for ${expected.name}: ${rows} != ${expected.rows}`);}return true;}
function arg(name,fallback=""){const at=process.argv.indexOf(`--${name}`);return at>=0?text(process.argv[at+1]):fallback;}
export async function main(){const manifestPath=resolve(arg("manifest"));if(!arg("manifest"))throw new Error("--manifest is required");const manifest=JSON.parse(readFileSync(manifestPath,"utf8"));const sqlPath=resolve(dirname(manifestPath),text(manifest.sqlFile));assertManifestChecksum(manifest,sqlPath);
 const environment=arg("environment","staging"),databaseName=arg("database-name",environment==="production"?"pawspace-prod-bengaluru":"pawspace-staging"),databaseId=arg("database-id",environment==="production"?text(process.env.PRODUCTION_D1_ID):text(process.env.STAGING_D1_ID)),confirm=arg("confirm");assertRestoreTarget({environment,databaseName,databaseId,productionId:text(process.env.PRODUCTION_D1_ID),stagingId:text(process.env.STAGING_D1_ID),confirm,breakGlass:process.argv.includes("--break-glass"),breakGlassToken:text(process.env.PAWSPACE_PRODUCTION_D1_RESTORE_BREAK_GLASS)});
 const info=infoIdentity(jsonOutput(["d1","info",databaseName,"--json"]));if(info.id!==databaseId)throw new Error("Wrangler D1 target identity mismatch");if(info.name&&info.name!==databaseName)throw new Error("Wrangler D1 target name mismatch");
 const existing=queryRows(databaseName,"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1");if(environment==="staging"&&existing.length)throw new Error("Isolated staging restore target is not empty; refusing to mutate it");
 // This is the first mutating command. Every environment, confirmation, identity and checksum guard is above it.
 wrangler(["d1","execute",databaseName,"--remote","--file",sqlPath,"--yes"]);validateRestoredInventory(databaseName,manifest.tables);console.log(JSON.stringify({ok:true,databaseName,databaseId,environment,checksum:manifest.sha256,tables:(manifest.tables||[]).length}));}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exit(1);});
