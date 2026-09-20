import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

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
 assert.match(route,/SELECT role_code FROM app_users WHERE email=\?/);
 assert.match(route,/role:text\(user\?\.role_code\)/);
 assert.match(login,/j\.role==="finance"/);
 assert.match(login,/\/mfa\?next=%2Fteam%2Ffinance/);
 assert.doesNotMatch(login,/j\.role==="finance"[^;]*window\.location\.assign\("\/team\/finance"\)/);
});

test("MFA return path rejects protocol-relative navigation",()=>{
 assert.match(page,/value\.startsWith\("\/"\)&&!value\.startsWith\("\/\/"\)/);
});
