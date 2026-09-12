import test from"node:test";
import assert from"node:assert/strict";
import{readFileSync}from"node:fs";
import{installWorkersHooks}from"./helpers/module-hooks.mjs";
import{freshSqlite,makeD1}from"./helpers/taxi-harness.mjs";

installWorkersHooks("__MFA_DB__","__MFA_ENV__");
const KEY="k".repeat(32),CODE="primary-password-fixture",EMAIL="anjali.finance33@tkpetcare.in",SECRET="JBSWY3DPEHPK3PXP";
const env={PAWSPACE_UAT_LOGIN:"on",PAWSPACE_UAT_SIGNING_KEY:KEY,PAWSPACE_UAT_ACCESS_CODE:CODE};
const cookiePart=value=>String(value||"").split(";")[0];

test("finance password session requires TOTP and revoke-all invalidates the established MFA session",async()=>{
 const sqlite=freshSqlite(),db=makeD1(sqlite);globalThis.__MFA_DB__=db;globalThis.__MFA_ENV__=env;
 const auth=await import("../lib/server-auth.ts");await auth.ensureSecurityTables(db);
 sqlite.exec(readFileSync(new URL("../drizzle/0037_admin_mfa_sessions.sql",import.meta.url),"utf8"));
 const login=await import("../app/api/staging-login/route.ts");
 const loginResponse=await login.POST(new Request("https://staging.pawspace.test/api/staging-login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:EMAIL,code:CODE})}));
 assert.equal(loginResponse.status,200);const primaryCookie=cookiePart(loginResponse.headers.get("set-cookie"));
 sqlite.prepare("UPDATE app_users SET mfa_enabled=1,mfa_secret=? WHERE email=?").run(SECRET,EMAIL);
 const finance=await import("../app/api/subscription-billing-admin/route.ts");
 const financeRequest=cookie=>new Request("https://staging.pawspace.test/api/subscription-billing-admin",{method:"POST",headers:{cookie,"content-type":"application/json"},body:JSON.stringify({action:"probe"})});
 const passwordOnly=await finance.POST(financeRequest(primaryCookie));
 assert.equal(passwordOnly.status,401);assert.match(JSON.stringify(await passwordOnly.json()),/MFA required/i);
 const{totpCode}=await import("../lib/admin-mfa.ts"),verify=await import("../app/api/v1/auth/mfa/verify/route.ts");
 const code=await totpCode(SECRET),verified=await verify.POST(new Request("https://staging.pawspace.test/api/v1/auth/mfa/verify",{method:"POST",headers:{cookie:primaryCookie,"content-type":"application/json"},body:JSON.stringify({code})}));
 assert.equal(verified.status,200);const mfaCookie=cookiePart(verified.headers.get("set-cookie"));assert.match(mfaCookie,/pawspace_admin_mfa=/);
 const combined=`${primaryCookie}; ${mfaCookie}`,authorized=await finance.POST(financeRequest(combined));
 assert.equal(authorized.status,400,"unsupported action proves finance authorization passed after MFA");
 const revoke=await import("../app/api/v1/auth/revoke-all-sessions/route.ts"),revoked=await revoke.POST(new Request("https://staging.pawspace.test/api/v1/auth/revoke-all-sessions",{method:"POST",headers:{cookie:combined}}));
 assert.equal(revoked.status,200);assert.ok((await revoked.json()).revoked>=1);
 const replay=await finance.POST(financeRequest(combined));assert.equal(replay.status,401);assert.match(JSON.stringify(await replay.json()),/MFA required/i);
 sqlite.close();
});
