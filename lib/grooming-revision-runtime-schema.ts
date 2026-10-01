import {expectedGroomingTriggers,assertGroomingRevisionInstallation,groomingInstallationPredicate} from './grooming-revision-installation';

import {groomingRevisionPrerequisiteDdl} from './grooming-revision-schema';

type InstallResult={status:'installed'|'repaired'|'intact';schemaVersion:number;installation:Epoch;approvalId:string};
type Epoch={epoch:number;incarnation:string};
type Approval={purpose:string;binding:string;schemaVersion:number;actorEmail:string;deploymentIncarnation:string;
 workersDrained:boolean;expiresAt:number;approvalId:string;expectedInstallation:Epoch|null;expectedDatabaseIncarnation:string|null};
const refuse=(message:string)=>new Response(message,{status:409});
/** Token-level schema comparison ignores formatting/comments outside quoted values. CHECK literals,
 * column/constraint order, keys, collations and every operator remain significant; unsupported SQL
 * refuses rather than guessing equivalence. PRAGMA contracts below verify the live structures too. */
export function groomingRevisionTableDefinitionTokens(sql:string):string[] {
 const tokens:string[]=[];let at=0;
 while(at<sql.length) {
  if(/\s/.test(sql[at])){at++;continue;}
  if(sql.startsWith('--',at)){const end=sql.indexOf('\n',at);at=end<0?sql.length:end+1;continue;}
  if(sql.startsWith('/*',at)){const end=sql.indexOf('*/',at+2);if(end<0)throw refuse('Unterminated schema comment');at=end+2;continue;}
  const ch=sql[at];
  if(["'",'"','`','['].includes(ch)) {
   const close=ch==='['?']':ch;let value='',ended=false;at++;
   while(at<sql.length){if(sql[at]===close){if(ch!=='['&&sql[at+1]===close){value+=close;at+=2;continue;}at++;ended=true;break;}value+=sql[at++];}
   if(!ended)throw refuse('Unterminated schema token');tokens.push(ch==="'"?'literal:'+value:value.toUpperCase());continue;
  }
  const match=/^(?:[A-Za-z_][A-Za-z0-9_$]*|[0-9]+|<=|>=|<>|!=|==|\|\||[(),=+*/%<>.;-])/.exec(sql.slice(at));
  if(!match)throw refuse('Unsupported schema syntax');tokens.push(match[0].toUpperCase());at+=match[0].length;
 }
 if(tokens.slice(0,5).join(' ')==='CREATE TABLE IF NOT EXISTS')tokens.splice(2,3);
 if(tokens.at(-1)===';')tokens.pop();return tokens;
}
function columnContract(ddl:string) {
 const tokens=groomingRevisionTableDefinitionTokens(ddl);const parts:string[][]=[];let depth=0,current:string[]=[];
 for(const token of tokens.slice(tokens.indexOf('(')+1)) {
  if(token===')'&&depth===0){parts.push(current);break;}
  if(token===','&&depth===0){parts.push(current);current=[];continue;}
  if(token==='(')depth++;if(token===')')depth--;
  if(depth===0&&token!==')')current.push(token);
 }
 return parts.map((part,cid)=>({cid,name:part[0],type:part[1],notnull:part.join(' ').includes('NOT NULL')?1:0,
  dflt_value:null,pk:part.join(' ').includes('PRIMARY KEY')?1:0,hidden:0}));
}
const literal=(value:string)=>"'"+value.replaceAll("'","''")+"'";
const assertSql=(condition:string)=>`SELECT CASE WHEN (${condition}) THEN 1 ELSE abs(-9223372036854775808) END`;
const id=(name:string)=>{if(!/^[a-z][a-z0-9_]*$/.test(name))throw refuse('Invalid schema identifier');return name;};

/** Explicit maintenance operation only. No request-path lazy install or repair and no seed/activation.
 * Drain evidence is an operator-managed server environment receipt, NOT a client assertion. Hosted
 * qualification must establish receipt issuance/withdrawal and real D1 trigger/batch behavior before use.
 */
export async function installGroomingRevisionRuntimeSchema(db:D1Database,actorEmail:string,completionAudit:(result:InstallResult)=>D1PreparedStatement) {
 const {env}=await import('cloudflare:workers');const runtime=env as unknown as Record<string,unknown>;
 if(db!==env.DB)throw new Response('Maintenance approval is restricted to the configured DB binding',{status:403});
 let approval:Approval;try {approval=JSON.parse(String(runtime.PAWSPACE_GROOMING_SCHEMA_INSTALL_APPROVAL||''));}
 catch {throw new Response('Server maintenance approval required',{status:403});}
 if(!approval||approval.purpose!=='grooming_revision_installation'||approval.binding!=='DB'||approval.schemaVersion!==2||
  approval.actorEmail!==actorEmail||approval.workersDrained!==true||typeof approval.approvalId!=='string'||!/^[-a-zA-Z0-9_]{8,128}$/.test(approval.approvalId)||
  !Number.isSafeInteger(approval.expiresAt)||approval.expiresAt<=Date.now()||approval.expiresAt>Date.now()+3600000||
  !String(runtime.PAWSPACE_DEPLOYMENT_INCARNATION||'')||approval.deploymentIncarnation!==runtime.PAWSPACE_DEPLOYMENT_INCARNATION||
  !Object.hasOwn(approval,'expectedInstallation')||!Object.hasOwn(approval,'expectedDatabaseIncarnation')) {
  throw new Response('Invalid server maintenance approval',{status:403});
 }
 if(typeof completionAudit!=='function')throw refuse('Trusted completion audit required');
 const objects=(await db.prepare("SELECT name,sql,type,tbl_name FROM sqlite_master WHERE type IN ('table','trigger')").all<{name:string;sql:string;type:string;tbl_name:string}>()).results;
 const tables=new Map(objects.filter(row=>row.type==='table').map(row=>[row.name,row.sql]));
 // Existing platform owners must establish their schemas. This operation never seeds their controls.
 const prerequisites=[...new Set(expectedGroomingTriggers.map(trigger=>/\bON\s+([a-z][a-z0-9_]*)\b/.exec(trigger.sql)?.[1])
  .filter((name):name is string=>Boolean(name)&&!['conversation_ownership_revisions','grooming_effective_control_revision','grooming_revision_installation_epoch'].includes(name!)))];
 const missing=prerequisites.filter(name=>!tables.has(name));if(missing.length)throw refuse(`Grooming schema prerequisites missing: ${missing.join(',')}`);
 for(const table of prerequisites) {
  const columns=new Set((await db.prepare(`PRAGMA table_info(${id(table)})`).all<{name:string}>()).results.map(row=>row.name));
  const required=expectedGroomingTriggers.filter(trigger=>new RegExp('\\bON\\s+'+table+'\\b').test(trigger.sql)).flatMap(trigger=>[...[...trigger.sql.matchAll(/(?:NEW|OLD)\.([a-z][a-z0-9_]*)/g)].map(match=>match[1]),...(/AFTER UPDATE OF ([a-z0-9_,]+) ON/.exec(trigger.sql)?.[1].split(',')??[])]);
  if(required.some(column=>!columns.has(column)))throw refuse(`Grooming schema prerequisite columns missing: ${table}`);
 }
 const ownedTables=groomingRevisionPrerequisiteDdl.map(ddl=>/CREATE TABLE IF NOT EXISTS ([a-z_]+)/.exec(ddl)![1]);
 for(const ddl of groomingRevisionPrerequisiteDdl) {
  const name=/CREATE TABLE IF NOT EXISTS ([a-z_]+)/.exec(ddl)![1];if(!tables.has(name))continue;
  if(JSON.stringify(groomingRevisionTableDefinitionTokens(tables.get(name)!))!==JSON.stringify(groomingRevisionTableDefinitionTokens(ddl)))throw refuse(`Incompatible revision table: ${name}`);
  const expected=columnContract(ddl);
  const actual=(await db.prepare(`PRAGMA table_xinfo(${id(name)})`).all<{cid:number;name:string;type:string;notnull:number;dflt_value:string|null;pk:number;hidden:number}>()).results;
  if(JSON.stringify(actual.map(column=>[column.cid,column.name.toUpperCase(),column.type.toUpperCase(),column.notnull,column.dflt_value,column.pk,column.hidden]))!==JSON.stringify(expected.map(column=>[column.cid,column.name,column.type,column.notnull,column.dflt_value,column.pk,column.hidden])))throw refuse(`Incompatible revision columns: ${name}`);
  if((await db.prepare(`PRAGMA foreign_key_list(${id(name)})`).all()).results.length)throw refuse(`Unexpected revision foreign key: ${name}`);
  const indexes=(await db.prepare(`PRAGMA index_list(${id(name)})`).all<{name:string;unique:number;origin:string;partial:number}>()).results;
  const primary=expected.filter(column=>column.pk&&column.type!=='INTEGER');
  if(indexes.length!==(primary.length?1:0)||indexes.some(index=>index.origin!=='pk'||index.unique!==1||index.partial!==0))throw refuse(`Unexpected revision index: ${name}`);
  for(const index of indexes) {
   const keys=(await db.prepare(`PRAGMA index_xinfo(${id(index.name)})`).all<{name:string;coll:string;desc:number;key:number}>()).results.filter(column=>column.key===1);
   if(keys.length!==primary.length||keys.some((column,at)=>column.name?.toUpperCase()!==primary[at].name||column.coll!=='BINARY'||column.desc!==0))throw refuse(`Incompatible revision key/collation: ${name}`);
  }
 }
 const names=new Set(expectedGroomingTriggers.map(trigger=>trigger.name));
 if(objects.some(row=>row.type==='trigger'&&ownedTables.includes(row.tbl_name)&&!names.has(row.name as typeof expectedGroomingTriggers[number]['name'])))throw refuse('Unexpected revision-table trigger');
 const epoch=tables.has('grooming_revision_installation_epoch')?
  await db.prepare('SELECT epoch,incarnation FROM grooming_revision_installation_epoch WHERE id=1').first<Epoch>():null;
 const control=tables.has('grooming_effective_control_revision')?
  await db.prepare('SELECT database_incarnation FROM grooming_effective_control_revision WHERE id=1').first<{database_incarnation:string}>():null;
 if((epoch?(approval.expectedInstallation?.epoch!==epoch.epoch||approval.expectedInstallation?.incarnation!==epoch.incarnation):approval.expectedInstallation!==null)||approval.expectedDatabaseIncarnation!==(control?.database_incarnation??null))throw refuse('Maintenance approval does not match current installation');
 const installed=new Map(objects.filter(row=>row.type==='trigger').map(row=>[row.name,row.sql]));
 const changed=expectedGroomingTriggers.filter(trigger=>installed.get(trigger.name)!==trigger.sql);
 const marker=tables.has('grooming_revision_installation')?
  await db.prepare('SELECT schema_version FROM grooming_revision_installation WHERE id=1').first<{schema_version:number}>():null;
 if(changed.length===0&&marker?.schema_version===2&&epoch&&control) {
  await assertGroomingRevisionInstallation(db);
  const result:InstallResult={status:'intact',schemaVersion:2,installation:epoch,approvalId:approval.approvalId};
  // Replay changes no schema/state, but its audited outcome still checks the exact installation.
  const replayGuard=db.prepare(assertSql(`(${groomingInstallationPredicate}) AND EXISTS(SELECT 1 FROM grooming_revision_installation_epoch WHERE id=1 AND epoch=? AND incarnation=?) AND EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1 AND database_incarnation=?) AND CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)<?`)).bind(epoch.epoch,epoch.incarnation,control.database_incarnation,approval.expiresAt);
  try {await db.batch([replayGuard,completionAudit(result),replayGuard]);}
  catch {throw refuse('Grooming intact replay audit or authority check failed');}
  return result;
 }
 const nextEpoch=epoch??{epoch:1,incarnation:crypto.randomUUID()};
 const databaseIncarnation=control?.database_incarnation??crypto.randomUUID();
 const triggerSnapshot=expectedGroomingTriggers.map(trigger=>installed.has(trigger.name)?`EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=${literal(trigger.name)} AND sql=${literal(installed.get(trigger.name)!)})`:`NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=${literal(trigger.name)})`).join(' AND ');
 const statements=groomingRevisionPrerequisiteDdl.map(sql=>db.prepare(sql));
 statements.push(
  db.prepare('INSERT OR IGNORE INTO grooming_revision_installation_epoch(id,epoch,incarnation) VALUES(1,?,?)').bind(nextEpoch.epoch,nextEpoch.incarnation),
  db.prepare('INSERT OR IGNORE INTO grooming_effective_control_revision(id,revision,database_incarnation) VALUES(1,1,?)').bind(databaseIncarnation),
  db.prepare(assertSql(`(${triggerSnapshot}) AND EXISTS(SELECT 1 FROM grooming_revision_installation_epoch WHERE id=1 AND epoch=? AND incarnation=?) AND EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1 AND database_incarnation=?) AND CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)<?`)).bind(nextEpoch.epoch,nextEpoch.incarnation,databaseIncarnation,approval.expiresAt),
  // Advances before DROP/CREATE; transaction rollback retains the previous installation on failure.
  db.prepare('UPDATE grooming_revision_installation_epoch SET epoch=epoch+1 WHERE id=1'),
  db.prepare('INSERT OR IGNORE INTO conversation_ownership_revisions(thread_id,revision) SELECT id,1 FROM communication_threads'),
 );
 for(const trigger of changed) {
  statements.push(db.prepare(`DROP TRIGGER IF EXISTS ${id(trigger.name)}`),db.prepare(trigger.sql));
 }
 statements.push(db.prepare('INSERT INTO grooming_revision_installation(id,schema_version) VALUES(1,2) ON CONFLICT(id) DO UPDATE SET schema_version=2'),
  db.prepare(assertSql(`(${groomingInstallationPredicate}) AND EXISTS(SELECT 1 FROM grooming_revision_installation_epoch WHERE id=1 AND epoch=? AND incarnation=?) AND CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)<?`)).bind(nextEpoch.epoch+1,nextEpoch.incarnation,approval.expiresAt));
 const result:InstallResult={status:epoch?'repaired':'installed',schemaVersion:2,installation:{epoch:nextEpoch.epoch+1,incarnation:nextEpoch.incarnation},approvalId:approval.approvalId};
 const finalAssertion=statements.pop()!;
 // Completion and readiness are one outcome. A failed audit or final assertion rolls back both.
 statements.push(completionAudit(result),finalAssertion);
 try {await db.batch(statements);}catch {throw refuse('Grooming schema installation lost authority or failed; readiness was not granted');}
 return result;
}
