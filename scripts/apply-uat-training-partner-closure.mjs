import fs from "node:fs";

const trainingPath="app/mobile-app/training-flow.tsx";
const partnerPath="app/partner-mobile/page.tsx";
const gatewayPath="lib/api-gateway.ts";
const routePath="app/api/uat-provider-switch/route.ts";
const testPath="tests/uat-training-partner-closure.test.mjs";

function replaceOnce(source,search,replacement,label){
  const index=source.indexOf(search);
  if(index<0)throw new Error(`Patch anchor missing: ${label}`);
  if(source.indexOf(search,index+search.length)>=0)throw new Error(`Patch anchor duplicated: ${label}`);
  return source.slice(0,index)+replacement+source.slice(index+search.length);
}
function replaceRegexOnce(source,pattern,replacement,label){
  const matches=[...source.matchAll(new RegExp(pattern.source,pattern.flags.includes("g")?pattern.flags:`${pattern.flags}g`))];
  if(matches.length!==1)throw new Error(`Expected one ${label} match, found ${matches.length}`);
  return source.replace(pattern,replacement);
}

let training=fs.readFileSync(trainingPath,"utf8");
training=replaceOnce(training,
  'const weekdayMap:Record<string,number[]>={"Tue & Sat":[2,6],"Wed & Sun":[3,0],"Every Saturday":[6],"Choose each session myself":[0,1,2,3,4,5,6]};',
  'const weekdayMap:Record<string,number[]>={"Tue & Sat":[2,6],"Wed & Sun":[3,0],"Every Saturday":[6]};',
  "fixed Training schedule map");
training=replaceOnce(training,
  'days=weekdayMap[frequency]||weekdayMap["Choose each session myself"]',
  'days=weekdayMap[frequency]||weekdayMap["Tue & Sat"]',
  "Training start fallback");
training=replaceOnce(training,
  'weekdayMap[frequency]||weekdayMap["Choose each session myself"]',
  'weekdayMap[frequency]||weekdayMap["Tue & Sat"]',
  "calendar preview fallback");
training=replaceOnce(training,'    [meet, setMeet] = useState(true),\n','',"bundled Meet state");
training=replaceOnce(training,'  const meetFee=meet&&!meetBookingId?Number(meetPackage?.base_price||0):0;\n','',"bundled Meet fee");
training=replaceOnce(training,'  const payableNow=(checkoutQuote?.amountDueNow??0)+meetFee;','  const payableNow=checkoutQuote?.amountDueNow??0;',"package payable amount");
training=replaceOnce(training,
  'setMeetBookingId(canonical.bookingId);setMeetPetKey(petKey);setMeetTrainerName(decision.provider.name);setMeet(false);setCheckoutQuote(null);',
  'setMeetBookingId(canonical.bookingId);setMeetPetKey(petKey);setMeetTrainerName(decision.provider.name);setCheckoutQuote(null);',
  "standalone Meet completion");
training=replaceRegexOnce(training,
  /\n        if\(meet&&!linkedMeetBookingId\)\{.*?setMeetTrainerName\(meetDecision\.provider\.name\);\}/s,
  '\n        // Meet & Greet is a standalone pre-package choice. A package booking may link an already-booked Meet, but never silently creates one.',
  "bundled Meet creation");
training=replaceOnce(training,
  'occurrences:quote.sessions,weekdays:weekdayMap[frequency],cadenceDays:frequency==="Choose each session myself"?7:undefined,preferredProviderId:selectedTrainer?.id',
  'occurrences:quote.sessions,weekdays:weekdayMap[frequency],preferredProviderId:selectedTrainer?.id',
  "fake per-session cadence");
training=replaceRegexOnce(training,
  /\n          <section className=\{styles\.meetTrainer\}>\n            <div className=\{styles\.meetPitch\}>\n              <span>NOT READY TO BUY A PACKAGE\?<\/span>.*?\n          <\/section>/s,
  '',
  "post-package Meet block");
training=replaceOnce(training,'              <option>Choose each session myself</option>\n','',"fake per-session option");
training=replaceOnce(training,
  '              <b>{meet&&!meetBookingId ? `${slotLabel(new Date(meetSlot))} · ${meetPackage?Number(meetPackage.direct_minutes_per_pet)+Number(meetPackage.coaching_minutes_per_pet):"—"} min · ${money(meetFee)}` : meetBookingId?`Booked separately · ${meetBookingId}`:"Skipped"}</b>',
  '              <b>{meetBookingId?`Booked separately · ${meetBookingId}`:"Not booked"}</b>',
  "Meet payment review");
training=replaceOnce(training,
  '{money(Math.round(plan.price*plan.splitDuePercent/100)+meetFee)} now · {money(plan.price-Math.round(plan.price*plan.splitDuePercent/100))} later under the canonical split schedule',
  '{money(Math.round(plan.price*plan.splitDuePercent/100))} now · {money(plan.price-Math.round(plan.price*plan.splitDuePercent/100))} later under the canonical split schedule',
  "split payment without Meet fee");
training=replaceOnce(training,
  '<span>{money(plan.price + meetFee)} before an eligible coupon</span>',
  '<span>{money(plan.price)} before an eligible coupon</span>',
  "full payment without Meet fee");
training=replaceOnce(training,
  '            Book every session now or keep dates flexible. App reminders go 24\n            hours and 2 hours before each session; expiry alerts start 15 days\n            before validity ends.',
  '            Choose one of the supported repeat schedules above. Every package session is shown before payment, and app reminders go 24\n            hours and 2 hours before each session; expiry alerts start 15 days before validity ends.',
  "calendar guidance");

const meetAlternative=`          <section className={styles.meetTrainer}>\n            <div className={styles.meetPitch}>\n              <span>MEET A TRAINER FIRST</span>\n              <h4>Prefer to meet a trainer before choosing a programme?</h4>\n              <p>Book a separate Meet &amp; Greet now. You can return later and choose a training package without mixing the two purchases.</p>\n            </div>\n            <div className={styles.meetSlots}>\n              {[futureIst(1,11),futureIst(2,15),futureIst(2,16)].map((date)=>{const slot=date.toISOString();return <button key={slot} className={meetSlot===slot?styles.selected:""} onClick={()=>setMeetSlot(slot)}>{slotLabel(date)}<small>{meetSlot===slot?"Selected":"Available"}</small></button>;})}\n            </div>\n            <p>Trainer availability is checked before booking. This creates one standalone, sandbox-paid canonical Meet &amp; Greet only.</p>\n            <button className={styles.meetOnly} onClick={confirmMeetFirst} disabled={scheduling || selectedPets.length === 0 || !selectedTrainer}>\n              {scheduling ? "Reserving Meet & Greet…" : "Book Meet & Greet only"}\n            </button>\n            {meetLinked && <article className={styles.meetConfirmed}><b>✓ Meet &amp; Greet booked</b><span>{slotLabel(new Date(meetSlot))} · {meetTrainerName||selectedTrainer?.name||"Assigned trainer"} · {meetBookingId}</span><small>You can continue to a programme now or return after the meeting.</small></article>}\n            {meetBookingId && !meetLinked && <article className={styles.meetConfirmed}><b>Meet &amp; Greet belongs to another dog selection</b><span>Select the original dogs to link that meeting, or book another Meet &amp; Greet for the current selection.</span></article>}\n            {scheduleError && <p role="alert">{scheduleError}</p>}\n          </section>\n`;
training=replaceOnce(training,
  '          <div className={styles.planGuide}>\n',
  `${meetAlternative}          <div className={styles.planGuide}>\n`,
  "pre-package Meet insertion");
if(training.includes("Choose each session myself"))throw new Error("Fake per-session option still present");
if(training.includes("NOT READY TO BUY A PACKAGE?"))throw new Error("Post-package Meet copy still present");
fs.writeFileSync(trainingPath,training);

let partner=fs.readFileSync(partnerPath,"utf8");
partner=replaceOnce(partner,
  'type RouteData={bookingId:string;destinationAddress:string;navigationUrl:string;providerLocation:{lat:number;lng:number;accuracyMeters?:number}|null;route?:{status:string;distanceMeters?:number;durationSeconds?:number;error?:string}};\n',
  'type RouteData={bookingId:string;destinationAddress:string;navigationUrl:string;providerLocation:{lat:number;lng:number;accuracyMeters?:number}|null;route?:{status:string;distanceMeters?:number;durationSeconds?:number;error?:string}};\ntype UatProvider={id:string;name:string;services:string[];cityId:string};\n',
  "UAT provider type");
partner=replaceOnce(partner,
  ' const[tab,setTab]=useState<Tab>("home"),[providerId,setProviderId]=useState(""),[jobs,setJobs]=useState<Job[]>([]),[selectedId,setSelectedId]=useState(""),[route,setRoute]=useState<RouteData|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState(""),[error,setError]=useState(""),[available,setAvailable]=useState(true);',
  ' const[tab,setTab]=useState<Tab>("home"),[providerId,setProviderId]=useState(""),[jobs,setJobs]=useState<Job[]>([]),[selectedId,setSelectedId]=useState(""),[route,setRoute]=useState<RouteData|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState(""),[error,setError]=useState(""),[available,setAvailable]=useState(true),[uatProviders,setUatProviders]=useState<UatProvider[]>([]),[uatCode,setUatCode]=useState(""),[switching,setSwitching]=useState(false);',
  "Partner UAT switch state");
partner=replaceOnce(partner,
  ' const selected=useMemo(()=>jobs.find(j=>j.bookingId===selectedId)||jobs[0]||null,[jobs,selectedId]);\n',
  ' const selected=useMemo(()=>jobs.find(j=>j.bookingId===selectedId)||jobs[0]||null,[jobs,selectedId]);\n const uatProvider=uatProviders.find(item=>item.id===providerId)||null;\n const providerName=uatProvider?.name||selected?.providerName||providerId||"Verified provider";\n const providerInitials=providerName.split(/\\s+/).filter(Boolean).slice(0,2).map(part=>part[0]?.toUpperCase()).join("")||"P";\n',
  "identity-driven Partner profile");
partner=replaceOnce(partner,
  ' useEffect(()=>{let active=true;fetch("/api/identity-session",{cache:"no-store"}).then(async r=>{const b=await r.json() as {data?:{subjectType?:string;subjectId?:string};error?:string};if(!r.ok||b.data?.subjectType!=="provider"||!b.data.subjectId)throw new Error(b.error||"Verified provider identity required");return b.data.subjectId;}).then(async id=>{if(!active)return;setProviderId(id);await loadJobs(id);}).catch(e=>active&&setError(e instanceof Error?e.message:"Unable to load provider"));return()=>{active=false};},[]);\n',
  ' useEffect(()=>{let active=true;fetch("/api/identity-session",{cache:"no-store"}).then(async r=>{const b=await r.json() as {data?:{subjectType?:string;subjectId?:string};error?:string};if(!r.ok||b.data?.subjectType!=="provider"||!b.data.subjectId)throw new Error(b.error||"Verified provider identity required");return b.data.subjectId;}).then(async id=>{if(!active)return;setProviderId(id);await loadJobs(id);}).catch(e=>active&&setError(e instanceof Error?e.message:"Unable to load provider"));return()=>{active=false};},[]);\n useEffect(()=>{let active=true;fetch("/api/uat-provider-switch",{cache:"no-store"}).then(async r=>{if(r.status===404)return null;const b=await r.json() as {data?:{providers?:UatProvider[]};error?:string};if(!r.ok)throw new Error(b.error||"Unable to load UAT providers");return b.data?.providers||[];}).then(list=>{if(active&&list)setUatProviders(list);}).catch(()=>undefined);return()=>{active=false};},[]);\n',
  "UAT provider roster load");
const switchFn=` const switchProvider=async(id:string)=>{\n  if(!id||id===providerId)return;\n  if(!uatCode.trim()){setError("Enter the UAT access code before switching provider identity");return;}\n  setSwitching(true);setError("");\n  try{const r=await fetch("/api/uat-provider-switch",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({providerId:id,code:uatCode})});const b=await r.json() as {data?:{providerId:string;name:string};error?:string};if(!r.ok||!b.data)throw new Error(b.error||"Unable to switch UAT provider");window.location.reload();}catch(e){setError(e instanceof Error?e.message:"Unable to switch UAT provider");setSwitching(false);}\n };\n`;
partner=replaceOnce(partner,' return <main className={styles.stage}>',`${switchFn} return <main className={styles.stage}>`,"Partner switch action");
partner=replaceRegexOnce(partner,
  /\{tab==="profile"&&<><div className=\{styles\.profile\}><div>AK<\/div><h1>Arjun Kumar<\/h1><p>Verified PawSpace partner<\/p><span>Groomer · Bengaluru<\/span><\/div><section className=\{styles\.menu\}>.*?Classic Trainer workspace<\/Link><\/div><\/>>\}/s,
  `{tab==="profile"&&<><div className={styles.profile}><div>{providerInitials}</div><h1>{providerName}</h1><p>Verified PawSpace partner</p><span>{uatProvider?`${uatProvider.services.join(" · ")} · ${uatProvider.cityId}`:`Provider ID · ${providerId||"loading"}`}</span></div>{uatProviders.length>0&&<section style={{padding:"12px",border:"1px solid #ddd",borderRadius:12,marginBottom:12}}><b>UAT provider switch</b><p style={{fontSize:12,margin:"6px 0"}}>UAT only. Uses the staging access code and issues a scoped provider identity session.</p><input type="password" value={uatCode} placeholder="UAT access code" onChange={e=>setUatCode(e.target.value)} style={{width:"100%",padding:10,marginBottom:8}}/><select value={providerId} disabled={switching} onChange={e=>void switchProvider(e.target.value)} style={{width:"100%",padding:10}}><option value={providerId}>{providerName}</option>{uatProviders.filter(item=>item.id!==providerId).map(item=><option key={item.id} value={item.id}>{item.name} · {item.services.join(", ")}</option>)}</select></section>}<section className={styles.menu}>{["Availability & service zones","Identity & verification","Bank & payout details","Quality & reviews","Learning & certification","Help & support"].map(x=><button key={x} onClick={()=>flash(`${x} is managed in the full partner operations workspace below.`)}>{x}<span>›</span></button>)}</section><Link className={styles.desktopLink} href="/partner-app">Open full partner operations workspace</Link><div style={{display:"flex",gap:8,marginTop:8,fontSize:11}}><Link href="/trainer">Classic Trainer workspace</Link></div></>}`,
  "hard-coded Partner profile");
if(partner.includes(">Arjun Kumar<"))throw new Error("Hard-coded Partner profile still present");
fs.writeFileSync(partnerPath,partner);

let gateway=fs.readFileSync(gatewayPath,"utf8");
gateway=replaceOnce(gateway,
  '||url.pathname==="/api/staging-login"',
  '||url.pathname==="/api/staging-login"||url.pathname==="/api/uat-provider-switch"',
  "UAT provider switch gateway exemption");
fs.writeFileSync(gatewayPath,gateway);

const route=`import{database}from"../../../lib/server-auth";\nimport{uatAccessCodeValid,uatLoginEnabled}from"../../../lib/uat-staging-auth";\nimport{getGovernedProvider,seedProviderCapacityDefaults}from"../../../lib/provider-capacity-governance";\nimport{upsertIdentityBinding}from"../../../lib/identity-binding";\nimport{issuePlatformSession,platformSessionCookie}from"../../../lib/platform-session";\n\ntype Row=Record<string,unknown>;\nconst json=(value:unknown,status=200,cookie?:string)=>Response.json(value,{status,headers:{"cache-control":"no-store",...(cookie?{"set-cookie":cookie}:{})}});\nfunction sameOriginWrite(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin write blocked",{status:403});}\n\nexport async function GET(){\n const{env}=await import("cloudflare:workers");\n if(!uatLoginEnabled(env as never))return json({error:"UAT provider switching is not enabled here"},404);\n const db=await database();await seedProviderCapacityDefaults(db);\n const rows=await db.prepare("SELECT id,name,city_id,services_json FROM provider_capacity_profiles WHERE live=1 AND status='active' ORDER BY name,id").all<Row>();\n return json({data:{providers:rows.results.map(row=>({id:String(row.id),name:String(row.name),cityId:String(row.city_id),services:(()=>{try{return JSON.parse(String(row.services_json||"[]")) as string[]}catch{return[]}})()}))}});\n}\n\nexport async function POST(request:Request){\n try{\n  sameOriginWrite(request);\n  const{env}=await import("cloudflare:workers");\n  if(!uatLoginEnabled(env as never))return json({error:"UAT provider switching is not enabled here"},404);\n  const body=await request.json().catch(()=>({})) as {providerId?:string;code?:string},providerId=String(body.providerId||"").trim();\n  if(!uatAccessCodeValid(env as never,body.code))return json({error:"Invalid UAT access code"},401);\n  if(!providerId)return json({error:"Provider is required"},400);\n  const db=await database(),provider=await getGovernedProvider(db,providerId);\n  if(!provider||!provider.live)return json({error:"That provider is not active in the UAT roster"},404);\n  const principalKey=\`uat-provider:\${provider.id}\`,actorId="uat-provider-switch";\n  const binding=await upsertIdentityBinding(db,{identitySource:"partner_otp",principalType:"identity_subject",principalKey,subjectType:"provider",subjectId:provider.id,cityId:provider.cityId,verificationState:"verified",expiresAt:null,metadata:{uatProviderSwitch:true},actorId,reason:"UAT-only provider identity switch"});\n  const issued=await issuePlatformSession(db,{bindingId:String(binding?.id||""),identitySource:"partner_otp",principalType:"identity_subject",principalKey,subjectType:"provider",subjectId:provider.id,ttlSeconds:28_800,metadata:{uatProviderSwitch:true}});\n  return json({data:{providerId:provider.id,name:provider.name,services:provider.services}},200,platformSessionCookie(issued.token,issued.ttlSeconds));\n }catch(error){if(error instanceof Response)return error;return json({error:error instanceof Error?error.message:"Unable to switch UAT provider"},500);}\n}\n`;
fs.mkdirSync("app/api/uat-provider-switch",{recursive:true});
fs.writeFileSync(routePath,route);

let tests=fs.readFileSync(testPath,"utf8");
if(!tests.includes("UAT provider switch route is production-dead"))tests+=`\nconst providerSwitch = fs.readFileSync(new URL("../app/api/uat-provider-switch/route.ts", import.meta.url), "utf8");\nconst gateway = fs.readFileSync(new URL("../lib/api-gateway.ts", import.meta.url), "utf8");\n\ntest("UAT provider switch route is production-dead and access-code governed", () => {\n  assert.match(providerSwitch, /uatLoginEnabled/);\n  assert.match(providerSwitch, /uatAccessCodeValid/);\n  assert.match(providerSwitch, /issuePlatformSession/);\n  assert.match(gateway, /\\/api\\/uat-provider-switch/);\n});\n`;
fs.writeFileSync(testPath,tests);

console.log("Applied consolidated Training UX + Partner UAT identity patch");
