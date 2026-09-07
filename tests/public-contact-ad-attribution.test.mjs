import test from"node:test";
import assert from"node:assert/strict";
import{DatabaseSync}from"node:sqlite";
import{readFileSync}from"node:fs";
import{installWorkersHooks}from"./helpers/module-hooks.mjs";

installWorkersHooks("__ADLEAD_DB__","__ADLEAD_ENV__");
function d1(sqlite){const statement=(sql,args=[])=>({bind:(...bound)=>statement(sql,bound),first:async()=>sqlite.prepare(sql).get(...args)??null,run:async()=>{const info=sqlite.prepare(sql).run(...args);return{success:true,meta:{changes:Number(info.changes)}};},all:async()=>({results:sqlite.prepare(sql).all(...args)})});return{prepare:sql=>statement(sql),batch:async list=>{const out=[];for(const item of list)out.push(await item.run());return out;},exec:async sql=>{sqlite.exec(sql);return{count:0,duration:0};}};}
let sqlite;
function fresh(){sqlite=new DatabaseSync(":memory:");globalThis.__ADLEAD_DB__=d1(sqlite);globalThis.__ADLEAD_ENV__={};}
function freshWithLegacyCrm(){fresh();sqlite.exec("CREATE TABLE crm_contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL, primary_phone TEXT NOT NULL, secondary_phone TEXT, email TEXT, area TEXT, pet_names TEXT, pet_summary TEXT, stage TEXT NOT NULL DEFAULT 'New lead', owner TEXT DEFAULT 'Unassigned', source TEXT DEFAULT 'Website', lifetime_value REAL DEFAULT 0, next_action TEXT, opportunity TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");}
const route=await import("../app/api/public-contact/route.ts");
const attribution=await import("../lib/lead-intake-ad-attribution.ts");

async function submit(body,ip="198.51.100.31"){const response=await route.POST(new Request("https://pawspace.test/api/public-contact",{method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":ip},body:JSON.stringify({name:"Ad Lead",phone:"9845012345",area:"HSR Layout",petNames:"Bruno",service:"Grooming",whatsappConsent:false,...body})}));return{response,body:await response.json()};}

test("EXECUTED: public intake binds Google click and UTM identifiers atomically to CRM and attribution",async()=>{
 fresh();const result=await submit({gclid:"GCLID-123",wbraid:"WBRAID-456",utmSource:"google",utmMedium:"cpc",utmCampaign:"blr-grooming",campaignId:"CMP-77",adId:"AD-88",landingUrl:"https://pawspace.in/grooming?gclid=GCLID-123"});
 assert.equal(result.response.status,201,JSON.stringify(result.body));assert.equal(result.body.attributionBound,true);
 const contact=sqlite.prepare("SELECT id,gclid,wbraid,utm_source,utm_medium,utm_campaign,campaign_id,ad_id,source FROM crm_contacts").get();assert.equal(contact.gclid,"GCLID-123");assert.equal(contact.wbraid,"WBRAID-456");assert.equal(contact.utm_source,"google");assert.equal(contact.utm_medium,"cpc");assert.equal(contact.utm_campaign,"blr-grooming");assert.equal(contact.campaign_id,"CMP-77");assert.equal(contact.ad_id,"AD-88");assert.match(contact.source,/google/);
 const lead=sqlite.prepare("SELECT * FROM lead_intake_ad_attribution").get();assert.equal(lead.contact_id,contact.id);assert.equal(lead.source_platform,"google");assert.equal(lead.click_id,"GCLID-123");assert.equal(lead.landing_url,"https://pawspace.in/grooming?gclid=GCLID-123");
 const downstream=sqlite.prepare("SELECT * FROM whatsapp_lead_attribution_intake").get();assert.equal(downstream.lead_id,lead.lead_id);assert.equal(downstream.customer_id,contact.id);assert.equal(downstream.source_platform,"google");assert.equal(downstream.gclid,"GCLID-123");assert.equal(downstream.wbraid,"WBRAID-456");assert.equal(downstream.campaign_id,"CMP-77");
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_lead_attribution").get().n,0,"no WhatsApp consent means no conversation-thread attribution row is fabricated");
 const activity=sqlite.prepare("SELECT detail FROM crm_activities WHERE type='lead_created'").get();const detail=JSON.parse(activity.detail);assert.equal(detail.adAttribution.gclid,"GCLID-123");assert.equal(detail.adAttribution.campaignId,"CMP-77");
});

test("EXECUTED: Meta click identifier is preserved and source platform is meta",async()=>{
 fresh();const result=await submit({fbclid:"FB-CLICK-999",utmSource:"facebook",utmMedium:"paid_social",utmCampaign:"meta-grooming",campaignId:"MC-1",adId:"MA-2"},"198.51.100.32");assert.equal(result.response.status,201);
 const lead=sqlite.prepare("SELECT source_platform,fbclid,click_id FROM lead_intake_ad_attribution").get();assert.equal(lead.source_platform,"meta");assert.equal(lead.fbclid,"FB-CLICK-999");assert.equal(lead.click_id,"FB-CLICK-999");
 const downstream=sqlite.prepare("SELECT source_platform,fbclid,click_id FROM whatsapp_lead_attribution_intake").get();assert.equal(downstream.source_platform,"meta");assert.equal(downstream.fbclid,"FB-CLICK-999");assert.equal(downstream.click_id,"FB-CLICK-999");
});

test("EXECUTED: legacy CRM table is upgraded idempotently before attributed insert",async()=>{
 freshWithLegacyCrm();const first=await submit({gclid:"G-LEGACY",utmSource:"google",utmMedium:"cpc"},"198.51.100.34");assert.equal(first.response.status,201,JSON.stringify(first.body));
 const columns=sqlite.prepare("PRAGMA table_info(crm_contacts)").all().map(row=>row.name);for(const column of["gclid","fbclid","wbraid","utm_source","utm_medium","utm_campaign","campaign_id","ad_id"])assert.ok(columns.includes(column),`missing upgraded ${column}`);
 const stored=sqlite.prepare("SELECT gclid,utm_source,utm_medium FROM crm_contacts").get();assert.equal(stored.gclid,"G-LEGACY");assert.equal(stored.utm_source,"google");assert.equal(stored.utm_medium,"cpc");
 assert.equal(sqlite.prepare("SELECT gclid FROM whatsapp_lead_attribution_intake").get().gclid,"G-LEGACY");
});

test("EXECUTED: organic/no-token lead remains valid without fabricating attribution",async()=>{
 fresh();const result=await submit({},"198.51.100.33");assert.equal(result.response.status,201);assert.equal(result.body.attributionBound,false);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM lead_intake_ad_attribution").get().n,0);
 const contact=sqlite.prepare("SELECT gclid,fbclid,wbraid,utm_source FROM crm_contacts").get();assert.equal(contact.gclid,null);assert.equal(contact.fbclid,null);assert.equal(contact.wbraid,null);assert.equal(contact.utm_source,null);
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_lead_attribution_intake").get().n,0);
});

test("EXECUTED: normalization sanitizes length and chooses deterministic click precedence",()=>{
 const normalized=attribution.normalizeLeadAdAttribution({gclid:" G-1 ",fbclid:" F-2 ",wbraid:" W-3 ",utmSource:" google "});assert.equal(normalized.sourcePlatform,"google");assert.equal(normalized.clickId,"G-1");assert.equal(normalized.fbclid,"F-2");assert.equal(normalized.wbraid,"W-3");assert.equal(normalized.utmSource,"google");
});

test("landing-page client forwards the full requested advertising parameter set",()=>{
 const source=readFileSync(new URL("../app/landing-pages/landing-lead-form.tsx",import.meta.url),"utf8");for(const token of["gclid","fbclid","wbraid","utm_source","utm_medium","utm_campaign","campaign_id","ad_id"])assert.match(source,new RegExp(`adParam\\(params,\\"${token}\\"`),`missing ${token}`);assert.match(source,/new URLSearchParams\(window\.location\.search\)/);assert.match(source,/landingUrl:window\.location\.href/);
});
