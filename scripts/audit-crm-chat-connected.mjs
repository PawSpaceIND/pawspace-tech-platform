/** Local browser -> actual CRM component/API -> transactional D1/outbox retry proof. No provider sends. */
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { installAiHooks, freshAiDb, seedCustomer, inboundMessage } from '../tests/helpers/ai-harness.mjs';
import { makeD1 } from '../tests/helpers/taxi-harness.mjs';
installAiHooks();
process.env.PAWSPACE_LOCAL_PREVIEW="off";
const { sqlite } = freshAiDb();
const db=makeD1(sqlite);globalThis.__AI_DB__=db;
const { ensureSecurityTables, resolveActor }=await import('../lib/server-auth.ts');
const { ensureWhatsAppUatTables }=await import('../lib/whatsapp-uat-adapter.ts');
const { ensureCustomer360Tables }=await import('../lib/customer-360.ts');
const route=await import('../app/api/crm/chat/route.ts');
const cx=process.argv.includes('--cx');
const conversations=await import('../app/api/conversations/route.ts');
const controls=await import('../app/api/whatsapp/conversation-control/route.ts');
const streamRoute=await import('../app/api/conversations/stream/route.ts');
await ensureSecurityTables(db);await ensureWhatsAppUatTables(db);await ensureCustomer360Tables(db);
const now=Date.now(),actor='crm-browser-audit@pawspace.test';
seedCustomer(sqlite,'CUS-BROWSER','Browser Customer','9876500099');
sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-BROWSER',?,'Browser Operator','admin','active',?,?)").run(actor,now,now);
await inboundMessage(sqlite,db,{threadId:'THREAD-BROWSER',customerId:'CUS-BROWSER',text:'Booking question',channel:'whatsapp',idempotencyKey:'browser-inbound'});
const {recordInboundMessage:recordAuditInboundMessage}=await import('../lib/conversation-governance.ts');
await recordAuditInboundMessage(db,{threadId:'THREAD-BROWSER',customerId:'CUS-BROWSER',channel:'whatsapp',payload:{text:'[image]',metaMessageType:'image',providerMediaId:'audit-pending-media',mediaPending:true},provider:'meta_whatsapp',providerReference:'wamid.audit.pending-media',eventId:'audit-pending-media',createdBy:'audit-fixture'});
sqlite.prepare("INSERT INTO customer_contact_preferences (customer_id,whatsapp_consent,updated_by,updated_at) VALUES ('CUS-BROWSER',1,'test',?)").run(now);
sqlite.prepare("INSERT INTO whatsapp_uat_sessions (customer_id,provider,last_inbound_at) VALUES ('CUS-BROWSER','meta_whatsapp',?)").run(now);
if(cx)sqlite.prepare("INSERT INTO whatsapp_uat_sessions (customer_id,provider,last_inbound_at) VALUES ('CUS-BROWSER','sandbox_simulator',?)").run(now);
const verifiedActor=await resolveActor(new Request('http://127.0.0.1/api/crm/chat',{headers:{'oai-authenticated-user-email':actor}}));
assert.equal(verifiedActor.email,actor);
assert.equal(verifiedActor.developmentPreview,false,'browser proof must exercise provisioned staff access');
const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';${cx?"import Page from './app/team/customer-experience/page.tsx';import Template from './app/team/customer-experience/template.tsx';":"import LiveChatPanel from './app/crm/live-chat-panel.tsx';"}createRoot(document.getElementById('root')).render(${cx?' <Template><Page/></Template> ':"<LiveChatPanel notify={message=>{document.getElementById('notice').textContent=message;}}/>"});`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,outfile:'bundle.js',format:'iife',jsx:'automatic',define:{'process.env':'{}','process.env.NODE_ENV':'"development"'}});
const sends=[];const writeResponses=[];
let holdWrite=false;let releaseWrite;let holdList=false;let heldReads=[];
let failReads=false;let getRequests=0;let inboundSequence=0;
const server=http.createServer(async(req,res)=>{
 try{
  if(req.url==='/audit-control'&&req.method==='POST'){
   const chunks=[];for await(const chunk of req)chunks.push(chunk);const action=JSON.parse(Buffer.concat(chunks).toString()).action;
   if(action==='incoming'){
    const {recordInboundMessage}=await import('../lib/conversation-governance.ts');
    await recordInboundMessage(db,{threadId:'THREAD-BROWSER',customerId:'CUS-BROWSER',channel:'whatsapp',payload:{text:`Incoming live audit ${++inboundSequence}`},provider:'sandbox_simulator',providerReference:`live-inbound-${inboundSequence}`,eventId:`live-inbound-${inboundSequence}`,createdBy:'audit-fixture'});
    }else if(action==='second_thread'){
    seedCustomer(sqlite,'CUS-OTHER','Other Customer','9876500088');
    await inboundMessage(sqlite,db,{threadId:'THREAD-OTHER',customerId:'CUS-OTHER',text:'Other customer question',channel:'whatsapp',idempotencyKey:'other-inbound'});
    sqlite.prepare("INSERT INTO customer_contact_preferences (customer_id,whatsapp_consent,updated_by,updated_at) VALUES ('CUS-OTHER',1,'test',?)").run(Date.now());
    sqlite.prepare("INSERT INTO whatsapp_uat_sessions (customer_id,provider,last_inbound_at) VALUES ('CUS-OTHER','sandbox_simulator',?)").run(Date.now());
   }else if(action==='fail_write')db.onSql('INSERT INTO security_audit_events',()=>{throw new Error('audit fails after committed outbound');});
   else if(action==='fail')failReads=true;
   else if(action==='recover')failReads=false;
   else if(action==='hold_write')holdWrite=true;
   else if(action==='hold_list')holdList=true;
   else if(action==='release_reads'){holdList=false;for(const release of heldReads)release();heldReads=[];}
   else if(action==='release_write'){holdWrite=false;releaseWrite?.();releaseWrite=undefined;}
   else if(action==='revoke')sqlite.prepare("UPDATE app_users SET status='disabled' WHERE id='USR-BROWSER'").run();
   else if(action==='restore')sqlite.prepare("UPDATE app_users SET status='active' WHERE id='USR-BROWSER'").run();
   else if(action==='read'){
    const row=sqlite.prepare("SELECT id FROM communication_messages WHERE direction='outbound' ORDER BY created_at DESC LIMIT 1").get();
    if(row){const {recordDeliveryEvent}=await import('../lib/communication-engine.ts');await recordDeliveryEvent(db,{messageId:row.id,provider:'meta_whatsapp',eventId:`live-read-${row.id}`,eventType:'read'});}
   }
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,action}));return;
  }
  if(req.url==='/audit-result'){
   const outboundMessages=sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE direction='outbound'").get().n;
   const outboxRows=sqlite.prepare('SELECT COUNT(*) n FROM communication_outbox').get().n;
   const result={heldReads:heldReads.length,writeResponses,getRequests,attempts:sends.length,outboundMessages,outboxRows,frontendRetryKeyStable:sends.length===2&&Boolean(sends[0].clientRequestId)&&sends[0].clientRequestId===sends[1].clientRequestId,externalDelivery:false};
   console.log(JSON.stringify(result));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));return;
  }
  if(req.url==='/bundle.css'){res.writeHead(200,{'content-type':'text/css'});res.end(bundle.outputFiles.find(file=>file.path.endsWith('.css'))?.text||'');return;}
  if(req.url==='/bundle.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(bundle.outputFiles.find(file=>file.path.endsWith('.js')).text);return;}
  if(!req.url.startsWith('/api/')){res.writeHead(200,{'content-type':'text/html'});res.end('<link rel="stylesheet" href="/bundle.css"><div id="notice" role="status"></div><div id="root"></div><script>window.addEventListener("error",e=>{document.getElementById("notice").textContent=e.message;});</script><script src="/bundle.js"></script>');return;}
  if(req.method==='GET'){getRequests++;if(failReads){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'Audit read outage'}));return;}}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=Buffer.concat(chunks).toString(),url=`http://127.0.0.1:${server.address().port}${req.url}`;
  const request=new Request(url,{method:req.method,headers:{...req.headers,'oai-authenticated-user-email':actor},...(body?{body}:{})});
  if(req.method==='POST')sends.push(JSON.parse(body));
  const selectedRoute=req.url.startsWith('/api/conversations/stream')?streamRoute:req.url.startsWith('/api/conversations')?conversations:req.url.startsWith('/api/whatsapp/conversation-control')?controls:route;
  if(selectedRoute===streamRoute){
   const abort=new AbortController();res.on('close',()=>abort.abort());
   const result=await streamRoute.GET(new Request(request,{signal:abort.signal}));res.writeHead(result.status,Object.fromEntries(result.headers));
   for await(const chunk of result.body)res.write(chunk);res.end();return;
  }
  const result=await selectedRoute[req.method](request);if(req.method==='GET'&&holdList&&req.url==='/api/conversations?status=open')await new Promise(resolve=>heldReads.push(resolve));if(req.method==='POST'&&holdWrite)await new Promise(resolve=>{releaseWrite=resolve;});res.writeHead(result.status,Object.fromEntries(result.headers));const responseText=await result.text();if(req.method==='POST')writeResponses.push({status:result.status,body:JSON.parse(responseText)});res.end(responseText);
 }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:'Internal audit server error'}));}
});
let browser;
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 if(process.argv.includes('--serve')){
  if(!process.argv.includes('--live'))db.onSql('INSERT INTO security_audit_events',()=>{throw new Error('audit fails after committed outbound');});
  console.log(`CRM_AUDIT_URL=http://127.0.0.1:${server.address().port}`);
  await new Promise(()=>{});
 }
 browser=await chromium.launch({headless:true});
 const page=await browser.newPage({extraHTTPHeaders:{'oai-authenticated-user-email':actor}});
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 if(cx){
  await page.getByText('Attachment not yet available',{exact:true}).waitFor();
  const composer=page.getByPlaceholder('Reply as PawSpace CX...');
  await composer.fill('Reply retained across customer activity');
  db.onSql('INSERT INTO security_audit_events',()=>{throw new Error('audit fails after committed outbound');});
  const firstResponse=page.waitForResponse(response=>response.url().includes('/api/whatsapp/conversation-control')&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Send',exact:true}).click();
  assert.equal((await firstResponse).status(),500);
  const {recordInboundMessage}=await import('../lib/conversation-governance.ts');
  await recordInboundMessage(db,{threadId:'THREAD-BROWSER',customerId:'CUS-BROWSER',channel:'whatsapp',payload:{text:'Incoming during pending retry'},provider:'sandbox_simulator',providerReference:'cx-retry-inbound',eventId:'cx-retry-inbound',createdBy:'audit-fixture'});
  await page.getByText('Incoming during pending retry',{exact:true}).waitFor();
  // Both the three-second stream and five-second fallback have had a chance to refresh.
  await page.waitForTimeout(6000);
  assert.equal(await composer.inputValue(),'Reply retained across customer activity');
  const retryResponse=page.waitForResponse(response=>response.url().includes('/api/whatsapp/conversation-control')&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Send',exact:true}).click();
  assert.equal((await retryResponse).status(),200);
  assert.equal(sends.length,2);assert.equal(sends[0].clientRequestId,sends[1].clientRequestId);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE direction='outbound'").get().n,1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM communication_outbox').get().n,1);
  await page.getByText('Reply queued through the governed WhatsApp outbox.',{exact:true}).waitFor();
  assert.equal(await composer.inputValue(),'');
  console.log(JSON.stringify({result:'passed',flow:'cx-event-draft-retry',attempts:2,outboundMessages:1,outboxRows:1,frontendRetryKeyStable:true,externalDelivery:false}));
 }else{
 await page.getByText('24h Session Open',{exact:true}).click();
 await page.getByText('Attachment not yet available',{exact:true}).waitFor();
 const composer=page.getByPlaceholder('Type WhatsApp message...');
 await composer.fill('Your booking request is received');
 db.onSql('INSERT INTO security_audit_events',()=>{throw new Error('audit fails after committed outbound');});
 const firstResponse=page.waitForResponse(response=>response.url().includes('/api/crm/chat')&&response.request().method()==='POST');
 await page.getByRole('button',{name:'Send WhatsApp',exact:true}).click();
 assert.equal((await firstResponse).status(),500);
 await page.getByRole('button',{name:'Send WhatsApp',exact:true}).waitFor();
 const retryResponse=page.waitForResponse(response=>response.url().includes('/api/crm/chat')&&response.request().method()==='POST');
 await page.getByRole('button',{name:'Send WhatsApp',exact:true}).click();
 assert.equal((await retryResponse).status(),200);
 await page.waitForFunction(()=>document.getElementById('notice')?.textContent.includes('message queued'));
 assert.equal(sends.length,2);
 assert.equal(sends[0].clientRequestId,sends[1].clientRequestId,'actual composer must retain request identity after failure');
 assert.ok(sends[0].clientRequestId);
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE direction='outbound'").get().n,1);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM communication_outbox').get().n,1);
 await page.getByText('Your booking request is received',{exact:true}).waitFor();
 assert.equal(await composer.inputValue(),'');
 if(process.env.CRM_AUDIT_SCREENSHOT)await page.screenshot({path:path.resolve(process.env.CRM_AUDIT_SCREENSHOT),fullPage:true});
 console.log(JSON.stringify({result:'passed',customerId:'CUS-BROWSER',threadId:'THREAD-BROWSER',attempts:2,outboundMessages:1,outboxRows:1,frontendRetryKeyStable:true,adminMessageVisible:true,externalDelivery:false}));
 }
}finally{
 if(browser)await browser.close();
 await new Promise(resolve=>server.close(resolve));sqlite.close();
}
