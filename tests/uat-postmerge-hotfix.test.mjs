import assert from"node:assert/strict";
import test from"node:test";
import{readFile}from"node:fs/promises";
const read=path=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("commercial POST responses preserve governed payment modes",async()=>{
  for(const path of ["app/api/boarding-commercial/route.ts","app/api/sitting-commercial/route.ts","app/api/training-commercial/route.ts"]){
    const source=await read(path);
    assert.match(source,/return json\(\{data:\{\.\.\.readiness,\.\.\.quote\}\},201\)/);
    assert.doesNotMatch(source,/return json\(\{data:\{\.\.\.quote,\.\.\.readiness\}\},201\)/);
  }
});

test("public contact rate limiting uses trusted Cloudflare identity and resets windows to now",async()=>{
  const source=await read("app/api/public-contact/route.ts");
  assert.match(source,/request\.headers\.get\("cf-connecting-ip"\)/);
  assert.doesNotMatch(source,/x-forwarded-for/);
  assert.match(source,/window_started_at=CASE WHEN window_started_at<\? THEN \? ELSE window_started_at END/);
  assert.match(source,/\.bind\(cutoff,cutoff,now,now,fingerprint\)/);
  assert.match(source,/phoneDigits\.length<10\|\|phoneDigits\.length>15/);
  assert.doesNotMatch(source,/error:error instanceof Error\?error\.message/);
});

test("public host trust strips customer and booking identifiers",async()=>{
  const source=await read("app/api/host-trust/route.ts");
  assert.match(source,/reviews\.map\(\(\{customerId:_customerId,bookingId:_bookingId,\.\.\.review\}\)=>review\)/);
  assert.match(source,/reviews:publicReviews/);
});

test("training requirement PATCH rejects runtime type confusion",async()=>{
  const source=await read("app/api/training-requirements/route.ts");
  assert.match(source,/body\.active!==undefined&&typeof body\.active!=="boolean"/);
  assert.match(source,/body\.sortOrder!==undefined&&\(!Number\.isInteger\(body\.sortOrder\)\|\|Number\(body\.sortOrder\)<1\)/);
  assert.match(source,/body\.label!==undefined&&typeof body\.label!=="string"/);
});
