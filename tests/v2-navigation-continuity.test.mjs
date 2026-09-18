import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const home=fs.readFileSync(new URL("../app/v2/page.tsx",import.meta.url),"utf8");
const activity=fs.readFileSync(new URL("../app/v2/activity/page.tsx",import.meta.url),"utf8");
const account=fs.readFileSync(new URL("../app/v2/account/page.tsx",import.meta.url),"utf8");
test("V2 navigation does not fall back to legacy mobile-app",()=>{assert.match(home,/href="\/v2\/activity"/);assert.match(home,/href="\/v2\/account"/);assert.doesNotMatch(home,/href="\/mobile-app"/);});
test("V2 profile opens account rather than signing out",()=>{assert.match(home,/title="Open account"/);assert.doesNotMatch(home,/profileButton.*signOut/);assert.match(account,/endV2CustomerSession/);});
test("V2 activity and account both consume canonical customer truth",()=>{assert.match(activity,/loadV2CustomerAccount/);assert.match(account,/loadV2CustomerAccount/);assert.match(activity,/same canonical PawSpace customer record/);});
