const origin=String(process.env.PAWSPACE_RAZORPAY_SANDBOX_RELAY_TARGET_ORIGIN||"").trim();
const sha=String(process.env.PAWSPACE_RAZORPAY_SANDBOX_RELAY_TARGET_SHA||"").trim();
if(!origin&&!sha){console.log("Razorpay sandbox relay disabled for this staging deploy.");process.exit(0)}
if(!origin||!sha)throw new Error("Relay target origin and SHA must be supplied together");
if(!/^[0-9a-f]{40}$/.test(sha))throw new Error("Relay target SHA must be exact lowercase 40-hex");
let url;try{url=new URL(origin)}catch{throw new Error("Relay target origin is invalid")}
const host=/^(pawspace-checkout-674-[1-9][0-9]{0,19}-[1-9][0-9]{0,5})\.([a-z0-9-]+)\.workers\.dev$/i.exec(url.hostname);
if(url.protocol!=="https:"||url.username||url.password||url.port||url.search||url.hash||!['','/'].includes(url.pathname)||!host)throw new Error("Relay target must be an exact isolated PR674 workers.dev origin");
const worker=host[1];
const account=String(process.env.CLOUDFLARE_ACCOUNT_ID||"").trim(),token=String(process.env.CLOUDFLARE_API_TOKEN||"").trim(),gh=String(process.env.GITHUB_TOKEN||"").trim();
if(!/^[a-f0-9]{32}$/i.test(account)||!token||!gh)throw new Error("Relay target verification credentials are missing");
const cf=async path=>{const r=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`,{headers:{authorization:`Bearer ${token}`},redirect:"error",signal:AbortSignal.timeout(20000)});const b=await r.json().catch(()=>({}));if(!r.ok||b.success!==true)throw new Error(`Cloudflare relay target verification failed (HTTP ${r.status})`);return b.result};
const settings=await cf(`/workers/scripts/${worker}/settings`),deployments=await cf(`/workers/scripts/${worker}/deployments`);
const bindings=Array.isArray(settings?.bindings)?settings.bindings:[],plain=Object.fromEntries(bindings.filter(b=>b?.type==="plain_text").map(b=>[String(b.name),String(b.text??b.value??"")]));
for(const [name,value] of Object.entries({PAWSPACE_DEPLOYMENT_ENV:"checkout-sandbox",PAWSPACE_RELEASE_SHA:sha,PAWSPACE_PAYMENT_ENV:"sandbox",FORBID_PRODUCTION:"true",PAWSPACE_PAYMENT_LIVE_APPROVED:"false"}))if(plain[name]!==value)throw new Error(`Relay target binding mismatch: ${name}`);
const webhook=bindings.find(b=>b?.name==="RAZORPAY_WEBHOOK_SECRET_SANDBOX");if(!webhook||!/secret/i.test(String(webhook.type||"")))throw new Error("Relay target sandbox webhook secret binding is missing");
const d1=bindings.filter(b=>b?.type==="d1");if(d1.length!==1||d1[0]?.name!=="DB")throw new Error("Relay target must have exactly one isolated DB binding");
const active=deployments?.deployments?.[0];if(!active?.id||active?.versions?.length!==1||active.versions[0]?.percentage!==100)throw new Error("Relay target does not have one 100% active deployment");
if(settings?.annotations?.["workers/message"]!==`checkout-sandbox ${sha}`)throw new Error("Relay target deployment annotation does not match candidate SHA");
const pr=await fetch("https://api.github.com/repos/PawSpaceIND/pawspace-tech-platform/pulls/674",{headers:{authorization:`Bearer ${gh}`,accept:"application/vnd.github+json"},redirect:"error",signal:AbortSignal.timeout(20000)});if(!pr.ok)throw new Error("Unable to verify PR674 for relay target");const body=await pr.json();if(body.state!=="open"||body.head?.sha!==sha||body.head?.ref!=="fix/customer-sandbox-checkout-wiring-20260909")throw new Error("Relay target SHA is not the current open PR674 head");
console.log(`Verified sandbox relay target ${worker} for exact PR674 SHA ${sha.slice(0,12)}…; secrets withheld.`);
