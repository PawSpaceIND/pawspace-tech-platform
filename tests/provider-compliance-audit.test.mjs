import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeCountingD1 } from "./helpers/d1-harness.mjs";

installWorkersHooks("__PROVIDER_COMPLIANCE_DB__", "__PROVIDER_COMPLIANCE_ENV__");

process.env.PAWSPACE_PAYMENT_ENV="sandbox";
process.env.PAWSPACE_PAYMENT_LIVE_APPROVED="false";

const ENV={PAWSPACE_PAYMENT_ENV:"sandbox",PAWSPACE_PAYMENT_LIVE_APPROVED:"false",PAWSPACE_SCHEDULING_ENV:"production",NODE_ENV:"test"};
globalThis.__PROVIDER_COMPLIANCE_ENV__=ENV;

function world(){const sqlite=new DatabaseSync(":memory:");const{db}=makeCountingD1(sqlite);globalThis.__PROVIDER_COMPLIANCE_DB__=db;return{sqlite,db};}

function ensureApplicationTable(sqlite){sqlite.exec("CREATE TABLE IF NOT EXISTS provider_onboarding_applications (id TEXT PRIMARY KEY,provider_id TEXT,vertical_key TEXT NOT NULL,updated_at INTEGER NOT NULL)");}

test("audit script hard-pins sandbox and carries the executable IDFY callback suite",()=>{
  assert.equal(process.env.PAWSPACE_PAYMENT_ENV,"sandbox");
  const pkg=JSON.parse(fs.readFileSync(new URL("../package.json",import.meta.url),"utf8"));
  const script=String(pkg.scripts?.["test:provider-compliance-audit"]||"");
  assert.match(script,/PAWSPACE_PAYMENT_ENV=sandbox/);
  assert.match(script,/PAWSPACE_PAYMENT_LIVE_APPROVED=false/);
  assert.match(script,/lane2-core-integration-boundaries\.test\.mjs/);
});

test("missing compliance record blocks except for an explicit seeded UAT/test fixture",async()=>{
  const{sqlite,db}=world();
  const capacity=await import("../lib/provider-capacity-governance.ts");
  const eligibility=await import("../lib/provider-assignment-eligibility.ts");
  await capacity.seedProviderCapacityDefaults(db);
  ensureApplicationTable(sqlite);

  const previousPreview=process.env.PAWSPACE_LOCAL_PREVIEW;
  delete process.env.PAWSPACE_LOCAL_PREVIEW;
  try{
    ENV.PAWSPACE_SCHEDULING_ENV="production";
    const production=await eligibility.providerAssignmentBlock(db,"groom_arun");
    assert.equal(production.blocked,true);
    assert.deepEqual(production.reasons,["no_onboarding_verification_record"]);

    ENV.PAWSPACE_SCHEDULING_ENV="uat";
    const fixture=await eligibility.providerAssignmentBlock(db,"groom_arun");
    assert.equal(fixture.blocked,false);
    assert.deepEqual(fixture.reasons,["uat_seed_fixture_exemption"]);
  }finally{if(previousPreview===undefined)delete process.env.PAWSPACE_LOCAL_PREVIEW;else process.env.PAWSPACE_LOCAL_PREVIEW=previousPreview;}
});

test("unconfigured policy and evaluation errors fail closed in matching",async()=>{
  const{sqlite,db}=world();
  ENV.PAWSPACE_SCHEDULING_ENV="production";
  const capacity=await import("../lib/provider-capacity-governance.ts");
  const eligibility=await import("../lib/provider-assignment-eligibility.ts");
  await capacity.seedProviderCapacityDefaults(db);
  ensureApplicationTable(sqlite);
  sqlite.prepare("INSERT INTO provider_onboarding_applications (id,provider_id,vertical_key,updated_at) VALUES ('APP-UNKNOWN','groom_arun','future_service',?)").run(Date.now());

  const unavailable=await eligibility.providerAssignmentBlock(db,"groom_arun");
  assert.equal(unavailable.blocked,true);
  assert.ok(unavailable.reasons.includes("verification_policy_unavailable"));

  const faulty={...db,prepare(sql){if(String(sql).startsWith("SELECT id,vertical_key FROM provider_onboarding_applications"))throw new Error("forced compliance read failure");return db.prepare(sql);}};
  const failed=await eligibility.providerAssignmentBlock(faulty,"groom_arun");
  assert.equal(failed.blocked,true);
  assert.deepEqual(failed.reasons,["verification_evaluation_error"]);
  const filtered=await eligibility.filterAssignableProviders(faulty,[{id:"groom_arun"}]);
  assert.deepEqual(filtered,[]);
});

test("secure provider document storage validates magic bytes independently of declared MIME",async()=>{
  const uploader=await import("../lib/provider-document-secure-upload.ts");
  const objects=new Map();
  const bucket={
    put:async(key,value,options)=>{const bytes=new Uint8Array(value);objects.set(key,{size:bytes.byteLength,contentType:options?.httpMetadata?.contentType});},
    head:async key=>{const item=objects.get(key);return item?{size:item.size,httpMetadata:{contentType:item.contentType}}:null;},
  };
  const pdf=Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n","utf8");
  const saved=await uploader.storeProviderDocumentSecurely({PAWSPACE_MEDIA_BUCKET:bucket},{providerId:"prov-1",applicationId:"app-1",documentType:"aadhaar",mimeType:"application/pdf",fileBase64:pdf.toString("base64")});
  assert.equal(saved.magicBytesVerified,true);
  assert.equal(saved.mimeType,"application/pdf");
  assert.ok(saved.fileRef.startsWith("r2://PAWSPACE_MEDIA_BUCKET/provider-documents/"));
  await assert.rejects(()=>uploader.storeProviderDocumentSecurely({PAWSPACE_MEDIA_BUCKET:bucket},{providerId:"prov-1",applicationId:"app-1",documentType:"aadhaar",mimeType:"image/jpeg",fileBase64:pdf.toString("base64")}),/MIME mismatch/);
  await assert.rejects(()=>uploader.storeProviderDocumentSecurely({PAWSPACE_MEDIA_BUCKET:bucket},{providerId:"prov-1",applicationId:"app-1",documentType:"aadhaar",mimeType:"application/pdf",fileBase64:Buffer.from("not-a-file").toString("base64")}),/signature is not recognized/);
});

test("expired required identity documents cannot be added or satisfy application submission",async()=>{
  const{sqlite,db}=world();
  const config=await import("../lib/provider-onboarding-configuration.ts");
  const onboarding=await import("../lib/provider-onboarding-transactional.ts");
  const draft=await config.createProviderOnboardingPolicyDraft(db,{payload:{verticalKey:"grooming",countryCode:"IN",verificationRules:{requiredDocumentTypes:["aadhaar"]}},actorEmail:"ops@pawspace.test"});
  await config.transitionProviderOnboardingPolicy(db,{policyId:draft.id,action:"submit_review",actorEmail:"ops@pawspace.test"});
  await config.transitionProviderOnboardingPolicy(db,{policyId:draft.id,action:"approve",actorEmail:"ops@pawspace.test"});
  await config.transitionProviderOnboardingPolicy(db,{policyId:draft.id,action:"activate",actorEmail:"ops@pawspace.test"});

  const app=await onboarding.createProviderApplication(db,{actorEmail:"ops@pawspace.test",payload:{providerId:"PROV-EXP",verticalKey:"grooming",countryCode:"IN"}});
  await assert.rejects(()=>onboarding.addProviderDocument(db,{applicationId:app.id,documentType:"aadhaar",fileRef:"r2://PAWSPACE_MEDIA_BUCKET/provider-documents/x",expiresAt:Date.now()-1,actorEmail:"ops@pawspace.test"}),/Expired provider documents/);

  sqlite.prepare("INSERT INTO provider_onboarding_documents (id,application_id,document_type,file_ref,classification,status,expires_at,created_by,created_at) VALUES ('DOC-OLD',?,'aadhaar','r2://PAWSPACE_MEDIA_BUCKET/provider-documents/old','sensitive_identity','uploaded',?,'ops',?)").run(app.id,Date.now()-1000,Date.now()-2000);
  await assert.rejects(()=>onboarding.transitionProviderApplication(db,{applicationId:app.id,action:"submit",actorEmail:"ops@pawspace.test"}),/documents are expired/);

  sqlite.prepare("DELETE FROM provider_onboarding_documents WHERE application_id=?").run(app.id);
  await onboarding.addProviderDocument(db,{applicationId:app.id,documentType:"aadhaar",fileRef:"r2://PAWSPACE_MEDIA_BUCKET/provider-documents/current",expiresAt:Date.now()+86_400_000,actorEmail:"ops@pawspace.test"});
  const submitted=await onboarding.transitionProviderApplication(db,{applicationId:app.id,action:"submit",actorEmail:"ops@pawspace.test"});
  assert.equal(submitted.status,"submitted");
});

test("staff identity-document action cannot persist a caller-supplied fileRef",()=>{
  const route=fs.readFileSync(new URL("../app/api/provider-onboarding/route.ts",import.meta.url),"utf8");
  const match=route.match(/else if\(body\.action==="add_document"\)\{([\s\S]*?)\n else if\(body\.action==="create_verification"\)/);
  assert.ok(match,"staff add_document branch must remain present");
  const branch=match[1];
  assert.match(branch,/if\(body\.fileRef\)return/);
  assert.match(branch,/storeProviderDocumentSecurely/);
  assert.match(branch,/fileBase64:body\.fileBase64/);
  assert.doesNotMatch(branch,/fileRef:body\.fileRef/);
});
