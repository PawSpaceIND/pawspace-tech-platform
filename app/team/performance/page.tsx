"use client";
import{useCallback,useEffect,useState}from"react";
import{Badge,Button,EmptyState,StatCard}from"../../components/ui";
import OpsShell from"../../components/ops-shell/OpsShell";
import styles from"./performance.module.css";

type Row={rank:number;employeeEmail:string;employeeName:string;leadsAssigned:number;meaningfulActions:number;qualifiedLeads:number;firstResponseRate:number|null;bookingConversions:number;netCollectedRevenue:number;refunds:number;cxEscalations:number;rankValue:number};
type SourceRun={id:string;policyId:string;policyVersion:number;periodStart:number;periodEnd:number;generatedAt:number}|null;
type Data={metric:string;teamCode:string;rows:Row[];totals:{leads:number;conversions:number;net:number;refunds:number};truth:{rankingAuthority:boolean;payrollAuthority:boolean;disciplinaryAuthority:boolean;source:string};period:{days:number;from:number;to:number;sourceRun:SourceRun}};
type Policy={id:string;name:string;status:string;version:number;teamCode:string;meaningfulActionTypes:string[];qualifiedOutcomes:string[];revenueBasis:string};
type Setup={teamRoster:Array<{teamCode:string;members:number}>;teamMembers:Array<{teamCode:string;employeeEmail:string;name:string}>;observedActionTypes:string[];observedOutcomes:string[];observedServiceCodes:string[];observedCityIds:string[]};
type Governance={policies:Policy[];setup:Setup};

const money=(v:number)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:0}).format(v||0);
const when=(v:number)=>new Date(v).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"});
const METRICS=[["net_collected_revenue","Net collected revenue"],["booking_conversions","Booking conversions"],["first_response_rate","First-response SLA %"],["qualified_leads","Qualified leads"],["meaningful_actions","Meaningful actions"]] as const;

/**
 * The screen used to end at a banner telling Sales Ops to go and call the governance API by hand, so on
 * staging it stayed permanently empty and looked broken. Everything the leaderboard needs - a policy,
 * its activation, and a fact run for the window on screen - is now doable here, and an empty board says
 * which of those is actually missing instead of showing zeros.
 */
export default function PerformancePage(){
 const[data,setData]=useState<Data|null>(null);
 const[governance,setGovernance]=useState<Governance|null>(null);
 const[metric,setMetric]=useState("net_collected_revenue");
 const[days,setDays]=useState(30);
 const[error,setError]=useState("");
 const[signInUrl,setSignInUrl]=useState("");
 const[notice,setNotice]=useState("");
 const[busy,setBusy]=useState("");
 const[actionTypes,setActionTypes]=useState("call,whatsapp,email");
 const[outcomes,setOutcomes]=useState("qualified,quote_sent,booked");
 const[memberEmail,setMemberEmail]=useState("");
 const[memberServices,setMemberServices]=useState("grooming");
 const[memberCities,setMemberCities]=useState("blr");

 const loadBoard=useCallback(async()=>{
  const response=await fetch(`/api/employee-performance?metric=${encodeURIComponent(metric)}&days=${days}`,{cache:"no-store"});
  const payload=await response.json().catch(()=>({}) as Record<string,unknown>);
  if(!response.ok){setSignInUrl(typeof payload.signInUrl==="string"?payload.signInUrl:"");throw new Error(String(payload.error||`Unable to load performance (HTTP ${response.status})`));}
  setData(payload.data as Data);setSignInUrl("");
 },[metric,days]);

 const loadGovernance=useCallback(async()=>{
  const response=await fetch("/api/sales-productivity-governance",{cache:"no-store"});
  const payload=await response.json().catch(()=>({}) as Record<string,unknown>);
  if(!response.ok){setSignInUrl(typeof payload.signInUrl==="string"?payload.signInUrl:"");throw new Error(String(payload.error||`Unable to load productivity governance (HTTP ${response.status})`));}
  const governanceData=(payload as{data?:Governance}).data;
  if(governanceData){
   setGovernance(governanceData);
   if(governanceData.setup?.observedActionTypes?.length)setActionTypes(governanceData.setup.observedActionTypes.join(","));
   if(governanceData.setup?.observedOutcomes?.length)setOutcomes(governanceData.setup.observedOutcomes.join(","));
   if(governanceData.setup?.observedServiceCodes?.length)setMemberServices(governanceData.setup.observedServiceCodes.join(","));
   if(governanceData.setup?.observedCityIds?.length)setMemberCities(governanceData.setup.observedCityIds.join(","));
  }
 },[]);

 const refresh=useCallback(async()=>{
  try{await Promise.all([loadBoard(),loadGovernance()]);setError("");}
  catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
 },[loadBoard,loadGovernance]);

 useEffect(()=>{let active=true;const run=()=>{void refresh();};run();const timer=setInterval(()=>{if(active)run();},60_000);return()=>{active=false;clearInterval(timer);};},[refresh]);

 async function governanceAction(body:Record<string,unknown>){
  const response=await fetch("/api/sales-productivity-governance",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const payload=await response.json().catch(()=>({}) as Record<string,unknown>);
  if(!response.ok)throw new Error(String(payload.error||`${String(body.action)} failed (HTTP ${response.status})`));
  return payload.data as Record<string,unknown>;
 }

 const activePolicy=governance?.policies.find(policy=>policy.status==="active_uat")||null;
 const draftPolicy=governance?.policies.find(policy=>policy.status==="draft")||null;
 const teamCode=data?.teamCode||"sales";
 const roster=governance?.setup?.teamRoster?.find(entry=>entry.teamCode===teamCode)?.members??0;
 const sourceRun=data?.period.sourceRun??null;
 const members=(governance?.setup?.teamMembers||[]).filter(entry=>entry.teamCode===teamCode);

 /**
  * Mapping a rep to a team had no surface anywhere in the app - the action existed only on the lead
  * assignment API - which is why staging reported zero reps and the leaderboard could never fill.
  */
 async function saveMember(employeeEmail:string,active:boolean){
  setBusy(`member:${employeeEmail}`);setNotice("");
  try{
   const response=await fetch("/api/lead-assignment-governance",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"save_member",employeeEmail,teamCode,serviceCodes:memberServices.split(",").map(value=>value.trim()).filter(Boolean),cityIds:memberCities.split(",").map(value=>value.trim()).filter(Boolean),active})});
   const payload=await response.json().catch(()=>({}) as Record<string,unknown>);
   if(!response.ok)throw new Error(String(payload.error||`Unable to update the ${teamCode} roster (HTTP ${response.status})`));
   setNotice(active?`${employeeEmail} is now on the ${teamCode} team. Generate a report to include them.`:`${employeeEmail} was removed from the ${teamCode} team.`);
   if(active)setMemberEmail("");
   await refresh();
  }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
  finally{setBusy("");}
 }

 async function createPolicy(){
  setBusy("policy");setNotice("");
  try{
   const meaningfulActionTypes=actionTypes.split(",").map(value=>value.trim()).filter(Boolean);
   const qualifiedOutcomes=outcomes.split(",").map(value=>value.trim()).filter(Boolean);
   const saved=await governanceAction({action:"save_policy",id:draftPolicy?.id,name:"Sales productivity (UAT baseline)",teamCode,timezone:"Asia/Kolkata",meaningfulActionTypes,qualifiedOutcomes,revenueBasis:"net_collected",requireCanonicalLeadBookingLink:true,effectiveFrom:Date.now()-365*86_400_000,reason:"UAT baseline productivity policy configured from the performance console"});
   await governanceAction({action:"activate_policy",policyId:String(saved.id),approvalReference:"UAT-CONSOLE",reason:"UAT baseline productivity policy activated from the performance console"});
   setNotice(`Policy ${String(saved.name)} is active. Generate a report to populate the leaderboard.`);
   await refresh();
  }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
  finally{setBusy("");}
 }

 async function generateReport(){
  setBusy("report");setNotice("");
  try{
   const periodEnd=Date.now(),periodStart=periodEnd-days*86_400_000;
   const result=await governanceAction({action:"generate_facts",periodStart,periodEnd,idempotencyKey:`console-${days}d-${new Date(periodEnd).toISOString().slice(0,13)}`});
   const facts=Array.isArray(result.facts)?result.facts.length:0;
   setNotice(result.duplicatePrevented?`This ${days}-day report was already generated: ${facts} employee ${facts===1?"row":"rows"} reused.`:`Report generated for the last ${days} days: ${facts} employee ${facts===1?"row":"rows"}.`);
   await refresh();
  }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
  finally{setBusy("");}
 }

 return <OpsShell
    eyebrow="PawSpace · Live employee performance"
    title="Sales performance leaderboard"
    description="Source-derived operating view. Rankings are for visibility and coaching only; they are not payroll, incentive or disciplinary authority."
    actions={<Badge tone={activePolicy?"success":"warning"} dot>{activePolicy?`Policy v${activePolicy.version} active`:"Policy not configured"}</Badge>}
    >

  {error?<div className={`${styles.panel} ${styles.panelError}`}><b>{error}</b>{signInUrl?<> · <a href={signInUrl}>Sign in again</a></>:null}</div>:null}
  {notice?<div className={styles.panel}>{notice}</div>:null}

  <section className={styles.controls}>
   <select className={styles.select} value={metric} onChange={event=>setMetric(event.target.value)} aria-label="Ranking metric">
    {METRICS.map(([value,label])=><option key={value} value={value}>{label}</option>)}
   </select>
   {[7,30,90].map(window=><Button key={window} size="sm" variant={days===window?"primary":"secondary"} onClick={()=>setDays(window)}>{window} days</Button>)}
   <Button size="sm" variant="ghost" onClick={()=>{void refresh();}}>Refresh</Button>
  </section>

  <section className={styles.tiles}>
   <StatCard label="Leads" value={data?.totals.leads??0} />
   <StatCard label="Conversions" value={data?.totals.conversions??0} />
   <StatCard label="Net revenue" value={money(data?.totals.net||0)} />
   <StatCard label="Refunds" value={money(data?.totals.refunds||0)} />
  </section>

  {!activePolicy&&governance?<section className={`${styles.panel} ${styles.panelSetup}`}>
   <div className={styles.panelHead}><h2>Set up the leaderboard</h2><Badge tone="warning">Sales Ops</Badge></div>
   <p className={styles.panelNote}>A leaderboard only exists once a policy states what counts. Nothing is inferred: name the action types that count as meaningful and the outcomes that count as qualified, then generate the report for the window you are looking at.</p>
   <div className={styles.steps}>
    <div className={styles.step}>
     <div className={styles.stepHead}><span className={styles.stepIndex}>1</span> Define and activate the policy for team {teamCode}</div>
     {governance.setup?.observedActionTypes?.length?<div className={styles.chips}>{governance.setup.observedActionTypes.map(value=><span key={value} className={styles.chip}>{value}</span>)}</div>:<p className={styles.panelNote}>No lead actions have been recorded yet, so this vocabulary is a starting point rather than an observation.</p>}
     <div className={styles.fieldRow}>
      <label className={styles.field}>Meaningful action types<input value={actionTypes} onChange={event=>setActionTypes(event.target.value)} placeholder="call,whatsapp,email" /></label>
      <label className={styles.field}>Qualified outcomes<input value={outcomes} onChange={event=>setOutcomes(event.target.value)} placeholder="qualified,quote_sent,booked" /></label>
     </div>
     <div className={styles.actions}><Button size="sm" disabled={busy==="policy"} onClick={()=>{void createPolicy();}}>{busy==="policy"?"Saving…":"Save & activate policy"}</Button></div>
    </div>
    <div className={styles.step}>
     <div className={styles.stepHead}><span className={styles.stepIndex}>2</span> Generate the report for the selected window</div>
     <p className={styles.panelNote}>Runs against canonical leads, SLA clocks, bookings and revenue events. Re-running the same window is idempotent.</p>
     <div className={styles.actions}><Button size="sm" variant="secondary" disabled={!activePolicy||busy==="report"} onClick={()=>{void generateReport();}}>Generate {days}-day report</Button>{activePolicy?null:<small>Available once the policy above is active.</small>}</div>
    </div>
   </div>
  </section>:null}

  {governance?<section className={styles.panel}>
   <div className={styles.panelHead}><h2>Team roster</h2><Badge tone={members.length?"info":"warning"}>{members.length} {members.length===1?"rep":"reps"} on {teamCode}</Badge></div>
   <p className={styles.panelNote}>The leaderboard measures the reps mapped to this team. A rep must already be an active platform user; service and city scope decide which leads they can be assigned.</p>
   {members.length?<ul className={styles.memberList}>{members.map(member=><li key={member.employeeEmail}>
    <span><b>{member.name||member.employeeEmail}</b> <small>{member.employeeEmail}</small></span>
    <Button size="sm" variant="ghost" disabled={busy===`member:${member.employeeEmail}`} onClick={()=>{void saveMember(member.employeeEmail,false);}}>Remove</Button>
   </li>)}</ul>:<p className={styles.panelNote}>No reps are mapped yet, so any report for this team will be empty.</p>}
   <div className={styles.fieldRow}>
    <label className={styles.field}>Employee email<input value={memberEmail} onChange={event=>setMemberEmail(event.target.value)} placeholder="rep@pawspace.in" /></label>
    <label className={styles.field}>Service scope<input value={memberServices} onChange={event=>setMemberServices(event.target.value)} placeholder="grooming,boarding" /></label>
    <label className={styles.field}>City scope<input value={memberCities} onChange={event=>setMemberCities(event.target.value)} placeholder="blr" /></label>
   </div>
   <div className={styles.actions}><Button size="sm" variant="secondary" disabled={!memberEmail.trim()||busy.startsWith("member:")} onClick={()=>{void saveMember(memberEmail.trim().toLowerCase(),true);}}>Add to {teamCode} team</Button></div>
  </section>:null}

  {activePolicy?<section className={styles.panel}>
   <div className={styles.panelHead}>
    <h2>Report</h2>
    <div className={styles.actions}>
     <Badge tone="info">{roster} {roster===1?"rep":"reps"} on {teamCode}</Badge>
     <Button size="sm" variant="secondary" disabled={busy==="report"} onClick={()=>{void generateReport();}}>{busy==="report"?"Generating…":`Generate ${days}-day report`}</Button>
    </div>
   </div>
   <p className={styles.panelNote}>{sourceRun?<>Showing run {sourceRun.id}, policy v{sourceRun.policyVersion}, generated {when(sourceRun.generatedAt)} for {when(sourceRun.periodStart)} - {when(sourceRun.periodEnd)}.</>:<>No fact run covers this window yet.</>}</p>
  </section>:null}

  {data&&data.rows.length>0?<div className={styles.tableWrap}>
   <table className={styles.table}>
    <thead><tr><th>#</th><th>Employee</th><th className={styles.numeric}>Leads</th><th className={styles.numeric}>Actions</th><th className={styles.numeric}>Qualified</th><th className={styles.numeric}>SLA</th><th className={styles.numeric}>Conversions</th><th className={styles.numeric}>Net</th></tr></thead>
    <tbody>{data.rows.map(row=><tr key={row.employeeEmail}>
     <td className={styles.rank}>{row.rank}</td>
     <td><div className={styles.person}><b>{row.employeeName}</b><small>{row.employeeEmail}</small></div></td>
     <td className={styles.numeric}>{row.leadsAssigned}</td>
     <td className={styles.numeric}>{row.meaningfulActions}</td>
     <td className={styles.numeric}>{row.qualifiedLeads}</td>
     <td className={styles.numeric}>{row.firstResponseRate==null?"-":`${row.firstResponseRate}%`}</td>
     <td className={styles.numeric}>{row.bookingConversions}</td>
     <td className={styles.numeric}>{money(row.netCollectedRevenue)}</td>
    </tr>)}</tbody>
   </table>
  </div>:null}

  {data&&data.rows.length===0&&activePolicy?<EmptyState
    title={roster===0?`No reps are mapped to team ${teamCode}`:sourceRun?"The report ran and returned no employee rows":"No report has been generated for this window"}
    body={roster===0
      ?`A policy is active, but the leaderboard reads reps from lead assignment memberships and team ${teamCode} has none. Map reps to the team, then generate the report.`
      :sourceRun?"The window covered by the latest run produced no facts for this team. Widen the window or check that leads, SLA clocks and bookings exist for the period."
      :"Generate the report for this window to populate the board."}
  />:null}

  <footer className={styles.footnote}>
   <b>Ranking authority:</b> NO · <b>Payroll authority:</b> NO · <b>Disciplinary authority:</b> NO · <b>Production ready:</b> NO
   {data?<> · Source: {data.truth.source}</>:null}
  </footer>
 </OpsShell>;
}
