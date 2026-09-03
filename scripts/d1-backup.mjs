import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { D1_DATABASE_ID } from "./d1-identity.mjs";

// One shared definition: these two scripts each held their own copy and they drifted.
const UUID=D1_DATABASE_ID;
const text=v=>String(v??"").trim();
export const sha256File=path=>createHash("sha256").update(readFileSync(path)).digest("hex");
export function assertBackupTarget({environment,databaseName,databaseId,productionId,stagingId}){
 if(!["production","staging"].includes(environment))throw new Error("D1 backup environment must be production or staging");
 if(!databaseName||!/^[a-zA-Z0-9_-]{3,80}$/.test(databaseName))throw new Error("A valid D1 database name is required");
 if(!UUID.test(databaseId))throw new Error("A valid D1 database id is required");
 if(environment==="production"&&(!productionId||databaseId!==productionId))throw new Error("Production backup database id does not match PRODUCTION_D1_ID");
 if(environment==="staging"&&stagingId&&databaseId!==stagingId)throw new Error("Staging backup database id does not match STAGING_D1_ID");
 if(productionId&&stagingId&&productionId===stagingId)throw new Error("Production and staging D1 ids must be isolated");
 return true;
}
function wrangler(args){const result=spawnSync(process.platform==="win32"?"npx.cmd":"npx",["wrangler",...args],{encoding:"utf8",stdio:["ignore","pipe","pipe"]});if(result.status!==0)throw new Error(`wrangler ${args[0]} failed: ${text(result.stderr||result.stdout).slice(0,500)}`);return text(result.stdout);}
function jsonOutput(args){const raw=wrangler(args);try{return JSON.parse(raw);}catch{throw new Error(`wrangler ${args[0]} did not return JSON`);}}
function flattened(value,out=[]){if(Array.isArray(value))for(const x of value)flattened(x,out);else if(value&&typeof value==="object"){out.push(value);for(const x of Object.values(value))flattened(x,out);}return out;}
function infoIdentity(info){const rows=flattened(info);const id=rows.map(r=>text(r.uuid||r.id||r.database_id)).find(UUID.test.bind(UUID))||"";const name=rows.map(r=>text(r.name||r.database_name)).find(Boolean)||"";return{id,name};}
function queryRows(databaseName,sql){const result=jsonOutput(["d1","execute",databaseName,"--remote","--json","--command",sql]);const rows=flattened(result).flatMap(r=>Array.isArray(r.results)?r.results:[]);return rows;}
function quoteIdent(name){if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))throw new Error(`Unsafe table name from sqlite_master: ${name}`);return `"${name}"`;}
export function collectRemoteInventory(databaseName){const tables=queryRows(databaseName,"SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");if(!tables.length)throw new Error("D1 schema inventory is empty");return tables.map(row=>{const name=text(row.name);const count=queryRows(databaseName,`SELECT COUNT(*) AS count FROM ${quoteIdent(name)}`)[0];return{name,rows:Number(count?.count??count?.COUNT??0),schemaSha256:createHash("sha256").update(text(row.sql)).digest("hex")};});}
function arg(name,fallback=""){const at=process.argv.indexOf(`--${name}`);return at>=0?text(process.argv[at+1]):fallback;}
export async function main(){const environment=arg("environment",text(process.env.PAWSPACE_D1_BACKUP_ENV));const databaseName=arg("database-name",environment==="production"?"pawspace-prod-bengaluru":"pawspace-staging");const databaseId=arg("database-id",environment==="production"?text(process.env.PRODUCTION_D1_ID):text(process.env.STAGING_D1_ID));assertBackupTarget({environment,databaseName,databaseId,productionId:text(process.env.PRODUCTION_D1_ID),stagingId:text(process.env.STAGING_D1_ID)});
 const info=infoIdentity(jsonOutput(["d1","info",databaseName,"--json"]));if(info.id!==databaseId)throw new Error(`Wrangler D1 identity mismatch for ${databaseName}`);if(info.name&&info.name!==databaseName)throw new Error("Wrangler D1 name mismatch");
 const inventory=collectRemoteInventory(databaseName);const stamp=new Date().toISOString().replace(/[-:.]/g,"").replace("Z","Z");const outputDir=resolve(arg("output-dir",join("artifacts","d1-backups")));mkdirSync(outputDir,{recursive:true});const base=`${databaseName}-${stamp}-${databaseId.slice(0,8)}`;const temp=join(outputDir,`.${base}.tmp.sql`),sqlPath=join(outputDir,`${base}.sql`),manifestPath=join(outputDir,`${base}.json`);
 wrangler(["d1","export",databaseName,"--remote","--output",temp]);const sql=readFileSync(temp);if(sql.length<32||!/CREATE TABLE|INSERT INTO|PRAGMA/i.test(sql.toString("utf8",0,Math.min(sql.length,200000))))throw new Error("D1 export does not look like a valid SQL snapshot");renameSync(temp,sqlPath);const manifest={version:1,immutable:true,environment,databaseName,databaseId,createdAt:new Date().toISOString(),sqlFile:basename(sqlPath),sha256:sha256File(sqlPath),bytes:sql.length,tables:inventory};writeFileSync(manifestPath,JSON.stringify(manifest,null,2),{flag:"wx",mode:0o600});console.log(JSON.stringify({ok:true,sqlPath,manifestPath,sha256:manifest.sha256,tables:inventory.length}));}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exit(1);});
