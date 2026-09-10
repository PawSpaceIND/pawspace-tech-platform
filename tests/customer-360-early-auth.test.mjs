import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const source=await readFile(new URL("../app/api/customer-360/route.ts",import.meta.url),"utf8");

test("Customer 360 rejects a credential-less GET before governed auth can initialize D1",()=>{
  const start=source.indexOf("export async function GET");
  const end=source.indexOf("export async function POST");
  const block=source.slice(start,end);
  const gate=block.indexOf("if(!hasAuthenticationMaterial(request))");
  const authorize=block.indexOf("await authorize(request,\"customers.view\")");
  assert.ok(start>=0&&end>start&&gate>=0,"the GET entry gate must exist");
  assert.ok(authorize>gate,"credential absence must be rejected before authorize can initialize security tables/D1");
  assert.match(block,/Authentication required/);
  assert.match(source,/pawspace_identity_session/);
  assert.match(source,/pawspace_uat/);
  assert.match(source,/isDevelopmentPreviewRequest/);
});

test("Customer 360 presence gate never replaces governed credential validation or RBAC",()=>{
  assert.match(source,/await authorize\(request,\"customers\.view\"\)/);
  assert.match(source,/customerDataAccessResolver\(db\)/);
  assert.doesNotMatch(source,/return\{email:.*roleCode.*permissions/);
});