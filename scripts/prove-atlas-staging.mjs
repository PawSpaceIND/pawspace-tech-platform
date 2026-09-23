import fs from "node:fs";
import { chromium } from "@playwright/test";

const base=String(process.env.STAGING_URL||"https://pawspace-staging.karthik-fce.workers.dev").replace(/\/$/,"");
const code=String(process.env.PAWSPACE_UAT_ACCESS_CODE||"").trim();
const expectedSha=String(process.env.EXPECTED_SHA||"").trim();
const allowFixtureSeed=String(process.env.ALLOW_REVENUE_MISSION_FIXTURE||"false").toLowerCase()==="true";
if(!code) throw new Error("PAWSPACE_UAT_ACCESS_CODE missing");
if(!expectedSha) throw new Error("EXPECTED_SHA missing");

const browser=await chromium.launch({headless:true});
const context=await browser.newContext();
const page=await context.newPage();
const result={
  expectedSha,base,login:false,teamAi:false,currentSnapshotGuard:false,historicalReconciliation:false,
  proposalSafety:false,fixtureSeeded:false,fixtureClosed:false,details:{}
};
let seededMissionId="";
let seededMissionActivated=false;

async function postRevenue(data){
  return context.request.post(base+"/api/revenue-mission-control",{headers:{origin:base},data,timeout:20000});
}
async function currentSnapshot(){
  const response=await context.request.get(base+"/api/ai-intelligence?mode=business_snapshot",{timeout:20000});
  if(!response.ok()) throw new Error("Atlas current snapshot failed HTTP "+response.status());
  const body=await response.json();
  if(body?.data?.productionReady!==false||body?.data?.autonomyScope!=="low_risk_internal_only") throw new Error("Atlas safety envelope mismatch");
  const snapshot=body?.data?.snapshot;
  if(snapshot?.mission?.value!==null||snapshot?.mission?.reason!=="current_mission_not_found") throw new Error("Atlas incorrectly selected an expired/future mission as current");
  return body;
}
async function bestEffortCloseSeededMission(){
  if(!seededMissionId||!seededMissionActivated||result.fixtureClosed) return;
  const close=await postRevenue({action:"close_mission",missionId:seededMissionId,reason:"Close isolated Atlas reconciliation fixture after proof."}).catch(()=>null);
  if(close?.ok()) result.fixtureClosed=true;
}

try{
  const login=await context.request.post(base+"/api/staging-login",{headers:{origin:base},data:{action:"login",code,email:"founder@pawspace.in"},timeout:20000});
  if(!login.ok()) throw new Error("Founder staging login failed HTTP "+login.status());
  result.login=true;

  const teamResp=await page.goto(base+"/team/ai",{waitUntil:"domcontentloaded",timeout:30000});
  if(!teamResp?.ok()) throw new Error("/team/ai failed HTTP "+(teamResp?.status()??"no_response"));
  await page.getByText("Atlas business intelligence",{exact:false}).first().waitFor({state:"visible",timeout:15000});
  result.teamAi=true;

  let current=await currentSnapshot();
  result.currentSnapshotGuard=true;

  let missionsResp=await context.request.get(base+"/api/revenue-mission-control",{timeout:20000});
  if(!missionsResp.ok()) throw new Error("Revenue Mission list failed HTTP "+missionsResp.status());
  let missions=await missionsResp.json();
  let items=Array.isArray(missions?.items)?missions.items:[];

  if(!items.length){
    if(!allowFixtureSeed) throw new Error("No Revenue Mission rows available for historical reconciliation");
    const now=Date.now();
    seededMissionId=`MISSION-ATLAS-PROOF-${expectedSha.slice(0,8).toUpperCase()}-${now}`;
    const periodStart=now-(3*24*60*60*1000),periodEnd=now-(2*24*60*60*1000);
    const save=await postRevenue({
      action:"save_mission",id:seededMissionId,name:`Atlas proof fixture ${expectedSha.slice(0,8)}`,
      targetAmount:1000,currency:"INR",periodStart,periodEnd,scope:{type:"company"},revenueBasis:"net_collected",
      reason:"Create isolated release-preview fixture for Atlas reconciliation proof."
    });
    if(save.status()!==201) throw new Error("Revenue Mission proof fixture save failed HTTP "+save.status()+" "+await save.text());
    const activate=await postRevenue({
      action:"activate_mission",missionId:seededMissionId,approvalReference:"UAT-PROOF",
      reason:"Activate expired isolated fixture for Atlas reconciliation proof."
    });
    if(!activate.ok()) throw new Error("Revenue Mission proof fixture activation failed HTTP "+activate.status()+" "+await activate.text());
    seededMissionActivated=true;
    result.fixtureSeeded=true;

    current=await currentSnapshot();
    missionsResp=await context.request.get(base+"/api/revenue-mission-control",{timeout:20000});
    if(!missionsResp.ok()) throw new Error("Revenue Mission list failed after fixture seed HTTP "+missionsResp.status());
    missions=await missionsResp.json();
    items=Array.isArray(missions?.items)?missions.items:[];
  }

  const historical=
    (seededMissionId&&items.find(x=>String(x?.mission?.id||"")===seededMissionId))||
    items.find(x=>String(x?.mission?.name||"").startsWith("Atlas proof fixture "))||
    items.find(x=>x?.mission?.status==="active_uat")||
    items[0];
  const missionId=String(historical?.mission?.id||"");
  if(!missionId) throw new Error("Historical mission id missing");

  const [atlasHistoricalResp,missionHistoricalResp]=await Promise.all([
    context.request.get(base+"/api/ai-intelligence?mode=business_snapshot&missionId="+encodeURIComponent(missionId),{timeout:20000}),
    context.request.get(base+"/api/revenue-mission-control?missionId="+encodeURIComponent(missionId),{timeout:20000})
  ]);
  if(!atlasHistoricalResp.ok()||!missionHistoricalResp.ok()) throw new Error("Historical reconciliation endpoint failed");
  const atlasHistorical=await atlasHistoricalResp.json(), missionHistorical=await missionHistoricalResp.json();
  const a=atlasHistorical?.data?.snapshot?.mission?.value;
  const m=missionHistorical?.summary;
  if(!a||!m) throw new Error("Historical mission payload missing");
  const pairs=[
    ["target",a.target,m.metrics.target],
    ["booked",a.booked,m.metrics.booked],
    ["collected",a.collected,m.metrics.collected],
    ["refunded",a.refunded,m.metrics.refunded],
    ["net",a.net,m.metrics.netCollected],
    ["percent",a.percent,m.metrics.percent],
    ["periodStart",a.period?.start,m.mission.periodStart],
    ["periodEnd",a.period?.end,m.mission.periodEnd]
  ];
  for(const [name,left,right] of pairs){
    if(Number(left)!==Number(right)) throw new Error(`Historical mission mismatch ${name}: Atlas=${left} RevenueMission=${right}`);
  }
  result.historicalReconciliation=true;

  const proposals=Array.isArray(current?.data?.proposals)?current.data.proposals:[];
  const staleExecutable=proposals.filter(p=>String(p?.basis_id||"").includes(missionId)&&["proposed","approved"].includes(String(p?.status||"")));
  if(staleExecutable.length) throw new Error("Stale historical mission still has executable Atlas proposal(s)");
  result.proposalSafety=true;

  if(seededMissionId){
    await bestEffortCloseSeededMission();
    if(!result.fixtureClosed) throw new Error("Revenue Mission proof fixture could not be closed after reconciliation");
  }

  result.details={
    currentMissionReason:current?.data?.snapshot?.mission?.reason||null,
    historicalMissionId:missionId,
    historicalMissionStatus:historical?.mission?.status||null,
    historicalMetrics:{
      target:a.target,booked:a.booked,collected:a.collected,refunded:a.refunded,net:a.net,percent:a.percent,
      periodStart:a.period?.start,periodEnd:a.period?.end
    },
    proposalCounts:{
      total:proposals.length,
      rejected:proposals.filter(p=>p?.status==="rejected").length,
      executableHistorical:staleExecutable.length
    },
    productionReady:current?.data?.productionReady,
    autonomyScope:current?.data?.autonomyScope,
    fixtureSeedAllowed:allowFixtureSeed
  };

  await page.screenshot({path:"atlas-team-ai.png",fullPage:true});
  fs.writeFileSync("atlas-staging-proof.json",JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
} finally {
  await bestEffortCloseSeededMission();
  await browser.close();
}
