// Signed-out /v2/grooming (guest preview) rendered through the REAL page component in headless Chromium with every
// /api/** answered in-page from fictional fixtures (identity-session 401 = signed out). Non-GET requests are aborted
// and counted; nothing is reserved, no OTP is sent. Catalogue price 1234 is a fixture value, not the workbook figure.
// Appearance: CSS modules are stubbed in this bundle, so "professional" and "cartoon" are verified at the markup level
// (html[data-paw-style] set before load, the native root/header/hero markup present, no render error) — computed
// styles need the hosted build. Run: PAWSPACE_TEST_BROWSER_EXECUTABLE=<chromium> node tests/service-fix-guest-preview.browser.cjs
(async()=>{
 const fs=await import('node:fs'),http=await import('node:http'),path=await import('node:path'),os=await import('node:os'),assert=await import('node:assert/strict');
 const {createRequire}=await import('node:module'),localResolve=createRequire(__filename).resolve;
 const dir=path.resolve(__dirname,'..'),dep=dir+'/node_modules/',esbuild=(await import(localResolve('esbuild'))).default,{chromium}=(await import(localResolve('playwright'))).default;
 const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'guest-preview-ui-'));
 fs.writeFileSync(scratch+'/entry.tsx',`import React from 'react';import{createRoot}from'react-dom/client';import Grooming from '${dir}/app/v2/grooming/page';
createRoot(document.getElementById('app')!).render(<Grooming/>);`);
 await esbuild.build({entryPoints:[scratch+'/entry.tsx'],bundle:true,outfile:scratch+'/bundle.js',nodePaths:[dep],jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'context',setup(b){
  b.onResolve({filter:/^react(?:\/.*)?$|^react-dom(?:\/.*)?$/},a=>({path:localResolve(a.path,{paths:[dep]})}));
  b.onResolve({filter:/^(next\/link|next\/navigation|next\/image|.*\.module\.css|.*\.css)$/},a=>({path:a.path,namespace:'stub'}));
  b.onLoad({filter:/.*/,namespace:'stub'},a=>({loader:'js',contents:a.path.endsWith('.css')?'export default new Proxy({}, {get:(_,k)=>String(k)})':a.path==='next/navigation'?'export const useRouter=()=>({push(){},replace(){}});export const useSearchParams=()=>new URLSearchParams(location.search);export const usePathname=()=>location.pathname;':`import React from 'react';export default function Stub({children,href,...props}){return React.createElement('${a.path==='next/link'?'a':'div'}',{href,...props},children)}`}));
 }}]});
 const server=http.createServer((q,s)=>q.url.startsWith('/bundle.js')?s.end(fs.readFileSync(scratch+'/bundle.js')):s.end('<div id="app"></div><script src="/bundle.js"></script>'));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({headless:true,executablePath:process.env.PAWSPACE_TEST_BROWSER_EXECUTABLE}),results=[];
 const bundle=(code,price)=>({petCount:1,packageCode:code+'-1',price,currency:'INR',slotMinutes:60,blockingMinutes:90,effectiveFrom:'2026-01-01',effectiveTo:null});
 const populated={serviceCode:'grooming',packages:[{code:'dog-bath',name:'Essential Bath',description:'Fixture description',audience:'dog',bundles:[bundle('dog-bath',1234)]},{code:'cat-routine',name:'Routine Grooming',description:'Fixture cat',audience:'cat',bundles:[bundle('cat-routine',2345)]}]};
 const empty={serviceCode:'grooming',packages:[]};
 function api(opts){let catalogueCalls=0;const fn=(r)=>{const u=new URL(r.url()),p=u.pathname;
  if(p==='/api/identity-session')return {status:401,body:{error:'Sign in'}};
  if(p==='/api/service-availability')return {status:200,body:{data:[{code:'grooming',enabled:true}]}};
  if(p==='/api/v2/grooming-catalogue'){catalogueCalls++;const step=opts.catalogue[Math.min(catalogueCalls-1,opts.catalogue.length-1)];return step;}
  if(p==='/api/v2/test-coins')return {status:404,body:{error:'disabled'}};
  return null;};fn.delayFor=opts.delayFor||0;return fn;}
 async function scenario(name,opts,check){
  const c=await browser.newContext({viewport:{width:390,height:800}}),p=await c.newPage();let aborted=0,unmocked=[];
  if(opts.style)await p.addInitScript(style=>{document.documentElement.setAttribute('data-paw-style',style);},opts.style);
  const handler=api(opts);
  await p.route('**/api/**',route=>{const r=route.request(),u=new URL(r.url());if(r.method()!=='GET'){aborted++;return route.abort();}const a=handler(r);if(!a){unmocked.push(u.pathname);return route.fulfill({status:500,contentType:'application/json',body:'{"error":"unmocked"}'});}const send=()=>route.fulfill({status:a.status,contentType:'application/json',body:JSON.stringify(a.body)});if(u.pathname==='/api/v2/grooming-catalogue'&&a.delayMs)return setTimeout(send,a.delayMs);return send();});
  await p.goto(base+'/');
  try{await check(p);results.push({scenario:name,result:'PASS',abortedWrites:aborted,unmocked,style:opts.style||'default'});}
  catch(error){results.push({scenario:name,result:'FAIL',error:String(error.message).slice(0,300),style:opts.style||'default'});}
  await c.close();
 }
 const text=async p=>(await p.locator('body').innerText());
 const native=async p=>{const main=p.locator('main[data-v2-hero-page="true"]');await main.waitFor();assert.equal(await p.locator('header img[alt="PawSpace"]').count(),1,'brand header');assert.equal(await p.getByRole('heading',{name:'Explore doorstep grooming'}).count(),1);assert.match(await text(p),/← Back to PawSpace/);assert.equal(await p.locator('img[src$="pawspace-grooming-editorial.webp"]').count(),1,'hero art');};
 for(const style of ['professional','cartoon'])await scenario(`populated (${style}): native header, hero and package cards from the server catalogue; Continue disabled until a choice; OTP only after Continue`,{style,catalogue:[{status:200,body:{data:populated}}]},async p=>{
  await native(p);
  await p.getByRole('button',{name:/Essential Bath/}).waitFor();
  let t=await text(p);assert.match(t,/₹1,234/);assert.ok(!t.includes('Routine Grooming'),'cat package waits for its pet type');assert.ok(!/1,349|1,899/.test(t));
  const cont=p.getByRole('button',{name:/Continue with this package/});assert.equal(await cont.isDisabled(),true);
  assert.equal(await p.getByLabel(/Verify mobile to continue grooming/).count(),0);
  await p.getByRole('button',{name:/Essential Bath/}).click();
  assert.equal(await cont.isEnabled(),true);assert.match(await text(p),/Your choice: Essential Bath/);
  await p.getByRole('radio',{name:'Cats'}).check();await p.getByRole('button',{name:/Routine Grooming/}).waitFor();assert.match(await text(p),/₹2,345/);
  await cont.click();await p.getByLabel(/Verify mobile to continue grooming/).waitFor();
  assert.match(await text(p),/Verify your mobile/);
  await p.getByRole('button',{name:'Keep browsing'}).click();assert.equal(await p.getByLabel(/Verify mobile to continue grooming/).count(),0);
 });
 await scenario('empty catalogue: authoritative empty message with Retry, no price, Continue disabled; Retry then shows the refreshed packages',{catalogue:[{status:200,body:{data:empty}},{status:200,body:{data:populated}}]},async p=>{
  await native(p);
  await p.getByText(/No grooming packages are published for this preview right now/).waitFor();
  const t=await text(p);assert.ok(!t.includes('₹'));assert.equal(await p.getByRole('button',{name:/Continue with this package/}).isDisabled(),true);
  await p.getByRole('button',{name:'Retry'}).click();
  await p.getByRole('button',{name:/Essential Bath/}).waitFor({timeout:10000});
  assert.ok(!(await text(p)).includes('No grooming packages are published'));
 });
 await scenario('loading: a slow Retry shows the refreshing state and keeps Continue disabled until the catalogue answers',{catalogue:[{status:200,body:{data:empty}},{status:200,body:{data:populated},delayMs:2500}]},async p=>{
  await p.getByRole('button',{name:'Retry'}).waitFor();await p.getByRole('button',{name:'Retry'}).click();
  await p.getByText('Refreshing the published packages…').waitFor();
  assert.equal(await p.getByRole('button',{name:/Continue with this package/}).isDisabled(),true);
  assert.ok(!(await text(p)).includes('No grooming packages are published'),'no empty claim while refreshing');
  await p.getByRole('button',{name:/Essential Bath/}).waitFor({timeout:10000});
 });
 await scenario('error: a failed Retry shows the server reason with Retry again, still no price, Continue disabled',{catalogue:[{status:200,body:{data:empty}},{status:503,body:{error:'Catalogue unavailable (fixture 503)'}}]},async p=>{
  await p.getByRole('button',{name:'Retry'}).waitFor();await p.getByRole('button',{name:'Retry'}).click();
  await p.getByRole('alert').waitFor({timeout:10000});
  const t=await text(p);assert.match(t,/Catalogue unavailable \(fixture 503\)/);assert.ok(!t.includes('₹'));
  assert.equal(await p.getByRole('button',{name:/Continue with this package/}).isDisabled(),true);
  assert.ok((await p.getByRole('button',{name:'Retry'}).count())>=1);
 });
 await scenario('initial catalogue failure stays on the page\'s existing fatal screen with Try again (unchanged behaviour, documented)',{catalogue:[{status:503,body:{error:'Catalogue unavailable (fixture 503)'}}]},async p=>{
  await p.getByText('We can’t begin this booking yet.').waitFor();
  assert.equal(await p.getByRole('button',{name:'Try again'}).count(),1);
  assert.equal(await p.locator('main[data-v2-hero-page="true"]').count(),0);
 });
 await browser.close();await new Promise(r=>server.close(r));fs.rmSync(scratch,{recursive:true,force:true});
 console.log(JSON.stringify(results,null,0));
 if(results.some(r=>r.result!=='PASS'))process.exitCode=1;
})();
