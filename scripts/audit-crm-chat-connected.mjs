/** Local browser -> actual CRM component/API -> transactional D1/outbox retry proof. No provider sends. */
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { installAiHooks, freshAiDb, seedCustomer, inboundMessage } from '../tests/helpers/ai-harness.mjs';
import { makeD1 } from '../tests/helpers/taxi-harness.mjs';
installAiHooks();
const { sqlite } = freshAiDb();
const db=makeD1(sqlite);globalThis.__AI_DB__=db;
const { ensureSecurityTables }=await import('../lib/server-auth.ts');
const { ensureWhatsAppUatTables }=await import('../lib/whatsapp-uat-adapter.ts');
const { ensureCustomer360Tables }=await import('../lib/customer-360.ts');
const route=await import('../app/api/crm/chat/route.ts');
await ensureSecurityTables(db);await ensureWhatsAppUatTables(db);await ensureCustomer360Tables(db);
const now=Date.now(),actor='crm-browser-audit@pawspace.test';
seedCustomer(sqlite,'CUS-BROWSER','Browser Customer','9876500099');
sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-BROWSER',?,'Browser Operator','admin','active',?,?)").run(actor,now,now);
await inboundMessage(sqlite,db,{threadId:'THREAD-BROWSER',customerId:'CUS-BROWSER',text:'Booking question',channel:'whatsapp',idempotencyKey:'browser-inbound'});
sqlite.prepare("INSERT INTO customer_contact_preferences (customer_id,whatsapp_consent,updated_by,updated_at) VALUES ('CUS-BROWSER',1,'test',?)").run(now);
sqlite.prepare("INSERT INTO whatsapp_uat_sessions (customer_id,provider,last_inbound_at) VALUES ('CUS-BROWSER','meta_whatsapp',?)").run(now);
const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import LiveChatPanel from './app/crm/live-chat-panel.tsx';createRoot(document.getElementById('root')).render(<LiveChatPanel notify={message=>{document.getElementById('notice').textContent=message;}}/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'}});
const sends=[];
const server=http.createServer(async(req,res)=>{
 try{
  if(req.url==='/audit-result'){
   const outboundMessages=sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE direction='outbound'").get().n;
   const outboxRows=sqlite.prepare('SELECT COUNT(*) n FROM communication_outbox').get().n;
   const result={attempts:sends.length,outboundMessages,outboxRows,frontendRetryKeyStable:sends.length===2&&Boolean(sends[0].clientRequestId)&&sends[0].clientRequestId===sends[1].clientRequestId,externalDelivery:false};
   console.log(JSON.stringify(result));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));return;
  }
  if(req.url==='/bundle.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(bundle.outputFiles[0].text);return;}
  if(!req.url.startsWith('/api/')){res.writeHead(200,{'content-type':'text/html'});res.end('<div id="notice" role="status"></div><div id="root"></div><script src="/bundle.js"></script>');return;}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=Buffer.concat(chunks).toString(),url=`http://127.0.0.1:${server.address().port}${req.url}`;
  const request=new Request(url,{method:req.method,headers:{...req.headers,'oai-authenticated-user-email':actor},...(body?{body}:{})});
  if(req.method==='POST')sends.push(JSON.parse(body));
  const result=await route[req.method](request);res.writeHead(result.status,Object.fromEntries(result.headers));res.end(await result.text());
 }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:String(error)}));}
});
let browser;
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 if(process.argv.includes('--serve')){
  db.onSql('INSERT INTO security_audit_events',()=>{throw new Error('audit fails after committed outbound');});
  console.log(`CRM_AUDIT_URL=http://127.0.0.1:${server.address().port}`);
  await new Promise(()=>{});
 }
 browser=await chromium.launch({headless:true});
 const page=await browser.newPage({extraHTTPHeaders:{'oai-authenticated-user-email':actor}});
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.getByText('24h Session Open',{exact:true}).click();
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
}finally{
 if(browser)await browser.close();
 await new Promise(resolve=>server.close(resolve));sqlite.close();
}
