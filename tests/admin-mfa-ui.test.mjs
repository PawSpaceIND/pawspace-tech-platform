import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { importLibModule } from "./helpers/ts-module-loader.mjs";

const page=fs.readFileSync("app/mfa/page.tsx","utf8");
const login=fs.readFileSync("app/staging-login/page.tsx","utf8");
const route=fs.readFileSync("app/api/staging-login/route.ts","utf8");

test("privileged MFA screen uses the governed enroll and verify APIs without a bypass",()=>{
 assert.match(page,/\/api\/v1\/auth\/mfa\/enroll/);
 assert.match(page,/\/api\/v1\/auth\/mfa\/verify/);
 assert.match(page,/6-digit authenticator code/);
 assert.match(page,/otpauthUri/);
 assert.match(page,/Setup secret/);
 assert.doesNotMatch(page,/mfa_enabled\s*=|UPDATE app_users|pawspace_admin_mfa=/);
});

test("first-time enrollment enables MFA before establishing the privileged session",()=>{
 const enable=page.indexOf('body:JSON.stringify({code:value})');
 const verify=page.indexOf('verifyAndContinue(value)');
 assert.ok(enable>=0&&verify>enable);
 assert.match(page,/MFA is enrolled\. Enter a fresh authenticator code to continue/);
});

test("staging finance login is routed through MFA before Team Finance",()=>{
 assert.match(route,/UAT_IDENTITIES\.find\(identity=>identity\.email===email\)\?\.role/);
 assert.doesNotMatch(route,/SELECT role_code FROM app_users WHERE email=/);
 assert.match(login,/j\.role==="finance"/);
 assert.match(login,/\/mfa\?next=%2Fteam%2Ffinance/);
 assert.doesNotMatch(login,/j\.role==="finance"[^;]*window\.location\.assign\("\/team\/finance"\)/);
});

test("MFA return path rejects protocol-relative navigation",()=>{
 assert.match(page,/target\.startsWith\("\/"\)&&!target\.startsWith\("\/\/"\)/);
});


test("real TOTP implementation accepts its current code and rejects a different code",async()=>{
 const {newTotpSecret,totpCode,verifyTotp}=await importLibModule("admin-mfa");
 const secret=newTotpSecret();
 assert.match(secret,/^[A-Z2-7]+$/);
 const now=Date.now();
 const code=await totpCode(secret,now);
 assert.match(code,/^\d{6}$/);
 assert.equal(await verifyTotp(secret,code,now),true);
 // verifyTotp accepts the code for any of three 30s windows (-30s, 0, +30s), so a hardcoded "wrong"
 // code is only wrong about 999,997 times in a million: when one of those three happens to be that
 // constant the assertion below fails on a correct implementation. That landed once in CI. Derive a
 // code that provably is not any of the three instead - four candidates cannot all collide with
 // three accepted codes.
 const accepted=new Set(await Promise.all([-30000,0,30000].map(drift=>totpCode(secret,now+drift))));
 assert.equal(accepted.has(code),true,"the current code must be one of the three windows verifyTotp accepts");
 const other=["000000","000001","000002","000003"].find(candidate=>!accepted.has(candidate));
 assert.ok(other,"four candidates cannot all collide with three accepted codes");
 assert.equal(await verifyTotp(secret,other,now),false);
});
