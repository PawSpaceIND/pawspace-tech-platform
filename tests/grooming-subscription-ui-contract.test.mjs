import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {transformSync} from "esbuild";
const source=readFileSync(new URL("../app/mobile-app/grooming-flow.tsx",import.meta.url),"utf8");
const helpers=["subscriptionPrice","subscriptionCode","subscriptionScope"].map(name=>{
 const match=source.match(new RegExp("function "+name+"\\([^\\n]+"));
 assert.ok(match);return match[0];
}).join("\n");
const compiled=transformSync(helpers+"\nexport {subscriptionPrice,subscriptionCode,subscriptionScope};",{loader:"ts",format:"esm"}).code;
const {subscriptionPrice,subscriptionCode,subscriptionScope}=await import("data:text/javascript;base64,"+Buffer.from(compiled).toString("base64"));
test("mobile subscription identifiers and care match governed seeded plans",()=>{
 assert.equal(subscriptionCode("3","dog"),"sub-3-dog");
 assert.equal(subscriptionCode("3","cat"),"sub-3-cat");
 assert.equal(subscriptionCode("6","dog"),"sub-6");
 assert.equal(subscriptionCode("12","dog"),"sub-12");
 assert.equal(subscriptionCode("trim3","dog"),"sub-trim");
 assert.equal(subscriptionScope("3","dog"),"basic");
 assert.equal(subscriptionScope("3","cat"),"routine");
 assert.equal(subscriptionScope("trim3","dog"),"trim");
 assert.equal(subscriptionPrice("3","cat",3597),2999);
});
test("shared credits cannot be priced per pet or sold with hidden scope changes",()=>{
 assert.doesNotMatch(source,/subscriptionPrice\(sub.id,type,sub.price\)\*count/);
 assert.doesNotMatch(source,/money\(planPrice\*count\)/);
 assert.match(source,/disabled=\{count>sessions\}/);
 assert.match(source,/Switches care to \{scope.name\}/);
 assert.match(source,/Each pet uses one shared credit per visit/);
 assert.doesNotMatch(source,/packageCode:sub\?`subscription-/);
});
