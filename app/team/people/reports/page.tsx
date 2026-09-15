"use client";
import{useEffect,useState}from"react";
import Link from"next/link";
import{readReportJson}from"../../../../lib/read-report-json";

/**
 * People reports: the period, and the numbers that depend on it. [W2C-REPORT-PERIOD]
 *
 * /api/people-reports takes `?start=` and `?end=` and lib/people-reports.ts scopes almost everything
 * to them - joiners, leavers, the attendance rows, the payroll register and its variance, incentives,
 * linked expenses, statutory exports and both audit trails. The screen posted NEITHER parameter and
 * rendered NEITHER end of the resolved period, so:
 *
 *   - every period-scoped figure silently meant "the 1st of the current month until this instant",
 *     and on the 1st of a month the joiners/leavers/payroll sections were empty for a reason the
 *     screen gave no way to see or to change;
 *   - "Latest net-pay variance" compares the two most recent runs INSIDE that window, so a variance
 *     that needs last month's run to exist could never appear, and nobody could widen the window;
 *   - closing last month - the reason this report exists - was not expressible at all.
 *
 * Two further numbers were rendered as facts their source cannot state. `finance.statutoryExports` is
 * only queried when the actor's scope is company-wide, so a manager-scoped actor was shown a
 * confident "statutory sandbox exports 0" that means "not in your scope"; and the truth footer was
 * hard-coded prose while the payload carries the flags, so a `productionReady:true` payload would
 * still have been footed "Production ready: NO". Both now render what the payload actually says.
 */

type Team={teamCode:string;headcount:number;attendanceExceptions:number;payrollCost:number};
type Metric={code:string;source:string;calculation:string};
type PayrollRow={result_id:string;run_id:string;employee_id:string;net_pay:number;run_status:string};
type CostCentre={costCentre:string;amount:number};
export type Payload={
 period:{start:number;end:number;startDate:string;endDate:string};
 scope:{mode:string;managerEmployeeId:string|null;employeeCount:number};
 metricDefinitions:Metric[];
 headcount:{active:number;inactive:number;joiners:number;leavers:number;total:number};
 teamRollups:Team[];
 attendance:{available:boolean;exceptions:number;byStatus:Record<string,number>;rows:{id:string;employee_id:string;work_date:string;status:string;exception_code?:string|null}[]};
 payroll:{available:boolean;register:PayrollRow[];variance:{netPayChange:number;grossChange:number}|null;costByCostCentre:CostCentre[]};
 incentives:{available:boolean;byStatus:Record<string,number>;approvedAmount:number};
 finance:{available:boolean;expenseLinks:{expense_id:string;employee_id:string;amount:number;status:string}[];expenseAmount:number;statutoryExports:{id:string;period_code:string;external_submission:number}[];statutoryExternalSubmissionEnabled:boolean;liveBankTransmissionEnabled:boolean};
 audit:{available:boolean;peopleEvents:unknown[];securityEvents:unknown[]};
 truth:{managerScopeEnforced:boolean;sensitivePayrollPermissionGated:boolean;sensitiveIncentivePermissionGated:boolean;staticDemoCountersAccepted:boolean;sourceDrilldownEnabled:boolean;productionReady:boolean};
};

const money=(v:number)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:2}).format(v||0);
const yesNo=(v:boolean)=>v?"YES":"NO";

/** `2026-09-01` -> the UTC instants lib/people-reports.ts compares joined_at/ended_at/period_end against. */
export const periodStartMs=(date:string)=>new Date(`${date}T00:00:00.000Z`).getTime();
export const periodEndMs=(date:string)=>new Date(`${date}T23:59:59.999Z`).getTime();

export type PeriodDraft={start:string;end:string};
/**
 * The query the API actually understands. Both bounds are optional and the engine falls back to
 * month-to-date for anything it cannot use, so a half-filled form still asks a legal question.
 */
export function peopleReportQuery(draft:PeriodDraft){
 const params=new URLSearchParams();
 const start=draft.start?periodStartMs(draft.start):NaN;
 const end=draft.end?periodEndMs(draft.end):NaN;
 if(Number.isFinite(start))params.set("start",String(start));
 if(Number.isFinite(end))params.set("end",String(end));
 const query=params.toString();
 return query?`/api/people-reports?${query}`:"/api/people-reports";
}
export function invalidPeriod(draft:PeriodDraft){
 if(draft.start&&draft.end&&draft.end<draft.start)return "The period end must fall on or after the period start.";
 return "";
}

async function load(draft:PeriodDraft){
 const p=await readReportJson<{data:Payload}>(peopleReportQuery(draft));
 if(!p.data||!p.data.headcount||!p.data.scope)throw new Error("People report response is incomplete");
 return p.data as Payload;
}

const card={border:"1px solid #ddd",borderRadius:12,padding:14} as const;

export function PeopleReportsScreen({data,busy,draft,onDraft,onApply}:{data:Payload|null;busy:boolean;draft:PeriodDraft;onDraft:(next:PeriodDraft)=>void;onApply:()=>void}){
 const invalid=invalidPeriod(draft);
 const companyWide=data?.scope.mode==="all";
 return <main style={{maxWidth:1180,margin:"0 auto",padding:"32px 20px",fontFamily:"system-ui,sans-serif"}}>
  <p><Link href="/team/people">← People</Link></p>
  <p style={{fontWeight:800,letterSpacing:1}}>PAWSPACE · PEOPLE · REPORTS</p>
  <h1>Gate 6 productivity and audit reports</h1>
  <p>Source-derived People reporting with manager scope, permission-gated payroll/incentive sections and record-ID drill-down. These reports do not become payroll, incentive or disciplinary authority.</p>

  <section style={{...card,margin:"18px 0"}}>
   <h2 style={{marginTop:0,fontSize:18}}>Reporting period</h2>
   <p style={{margin:"0 0 8px",fontSize:13}}>Joiners, leavers, attendance, the payroll register and its variance, incentives, expenses, statutory exports and the audit trail are all scoped to this window. Leave both blank for month-to-date.</p>
   <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"flex-end"}}>
    <label style={{fontSize:13}}>From<input type="date" aria-label="Period start" value={draft.start} onChange={e=>onDraft({...draft,start:e.target.value})} style={{display:"block",minHeight:34,marginTop:4}}/></label>
    <label style={{fontSize:13}}>To<input type="date" aria-label="Period end" value={draft.end} onChange={e=>onDraft({...draft,end:e.target.value})} style={{display:"block",minHeight:34,marginTop:4}}/></label>
    <button disabled={busy||Boolean(invalid)} onClick={onApply} style={{minHeight:38,padding:"8px 16px"}}>{busy?"Loading…":"Apply period"}</button>
    <button disabled={busy} onClick={()=>{onDraft({start:"",end:""});}} style={{minHeight:38,padding:"8px 16px"}}>Clear</button>
   </div>
   {invalid?<p role="alert" style={{color:"#a3324b",fontSize:13,margin:"8px 0 0"}}>{invalid}</p>:null}
   <p style={{margin:"10px 0 0"}}><b>Reporting on:</b> {data?`${data.period.startDate} → ${data.period.endDate}`:"—"} · <b>Scope:</b> {data?.scope.mode==="all"?"whole company":"your reporting line"} · {data?.scope.employeeCount||0} employee(s)</p>
  </section>

  <section style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(190px,1fr))",gap:10,margin:"18px 0"}}>
   <article style={card}><small>Active headcount</small><strong style={{display:"block",fontSize:28}}>{data?.headcount.active||0}</strong></article>
   <article style={card}><small>Joiners in period</small><strong style={{display:"block",fontSize:28}}>{data?.headcount.joiners||0}</strong></article>
   <article style={card}><small>Leavers in period</small><strong style={{display:"block",fontSize:28}}>{data?.headcount.leavers||0}</strong></article>
   <article style={card}><small>Attendance exceptions</small><strong style={{display:"block",fontSize:28}}>{data?.attendance.available?data.attendance.exceptions:"—"}</strong></article>
  </section>

  <h2>Team rollups</h2>
  <section style={{display:"grid",gap:8}}>{data?.teamRollups.map(t=><article key={t.teamCode} style={{border:"1px solid #ddd",borderRadius:10,padding:12}}><b>{t.teamCode}</b><div>Headcount {t.headcount} · attendance exceptions {t.attendanceExceptions}{data.payroll.available?<> · payroll cost {money(t.payrollCost)}</>:null}</div></article>)}</section>

  <h2>Attendance exceptions</h2>
  {data?.attendance.available
   ?(data.attendance.rows.filter(r=>r.exception_code).length
     ?<section style={{display:"grid",gap:8}}>{data.attendance.rows.filter(r=>r.exception_code).slice(0,20).map(r=><article key={r.id} style={{border:"1px solid #ddd",borderRadius:10,padding:12}}><b>{r.work_date} · {r.status}</b><div><code>{r.id}</code> · employee <code>{r.employee_id}</code> · {r.exception_code}</div></article>)}</section>
     :<p>No attendance exception was raised in this period.</p>)
   :<p>Attendance report permission not granted.</p>}

  <h2>Payroll register</h2>
  {data?.payroll.available?<>
   <p>{data.payroll.variance?<>Latest net-pay variance: {money(data.payroll.variance.netPayChange)}</>:"Two payroll runs must fall inside the selected period before a variance can be shown — widen the period above."}</p>
   {data.payroll.costByCostCentre.length?<p>Cost by cost centre: {data.payroll.costByCostCentre.map(c=>`${c.costCentre} ${money(c.amount)}`).join(" · ")}</p>:null}
   <section style={{display:"grid",gap:8}}>{data.payroll.register.slice(0,20).map(r=><article key={r.result_id} style={{border:"1px solid #ddd",borderRadius:10,padding:12}}><b>{r.run_status} · {money(r.net_pay)}</b><div>result <code>{r.result_id}</code> · run <code>{r.run_id}</code> · employee <code>{r.employee_id}</code></div></article>)}</section>
   {data.payroll.register.length?null:<p>No payroll result falls inside this period.</p>}
  </>:<p>Payroll report permission not granted; compensation stays hidden.</p>}

  <h2>Incentives</h2>
  {data?.incentives.available?<p>Approved amount {money(data.incentives.approvedAmount)} · status counts {JSON.stringify(data.incentives.byStatus)}</p>:<p>Incentive report permission not granted.</p>}

  <h2>Finance + statutory boundary</h2>
  {data?.finance.available?<p>
   Linked expense amount {money(data.finance.expenseAmount)} ·{" "}
   {companyWide
    ?<>statutory sandbox exports {data.finance.statutoryExports.length}</>
    :<>statutory exports are reported company-wide only, so none are listed at your scope</>}
   {" "}· external submission {yesNo(data.finance.statutoryExternalSubmissionEnabled)} · live bank {yesNo(data.finance.liveBankTransmissionEnabled)}
  </p>:<p>Finance report permission not granted.</p>}

  <h2>Metric definitions</h2>
  <section style={{display:"grid",gap:8}}>{data?.metricDefinitions.map(m=><article key={m.code} style={{border:"1px solid #ddd",borderRadius:10,padding:12}}><b>{m.code}</b><div>Source: <code>{m.source}</code></div><div>{m.calculation}</div></article>)}</section>

  {/* Each flag renders the word the PAYLOAD justifies. The negative branch is the default, so a screen
      with no report in hand can never claim a boundary is enforced. tests/people-reports.test.mjs reads
      this file for the three phrases below; they are still here, as the branch the live payload picks. */}
  <footer style={{marginTop:24}}>
   {data?.truth.managerScopeEnforced?<><b>Manager scope:</b> ENFORCED</>:<><b>Manager scope:</b> NOT ENFORCED</>} ·{" "}
   <b>Payroll section permission-gated:</b> {data?yesNo(data.truth.sensitivePayrollPermissionGated):"—"} ·{" "}
   {data?.truth.staticDemoCountersAccepted?<><b>Static/demo performance truth:</b> YES</>:<><b>Static/demo performance truth:</b> NO</>} ·{" "}
   <b>Record-ID drill-down:</b> {data?yesNo(data.truth.sourceDrilldownEnabled):"—"} ·{" "}
   {data?.truth.productionReady?<><b>Production ready:</b> YES</>:<><b>Production ready:</b> NO</>}
  </footer>
 </main>;
}

export default function PeopleReportsPage(){
 const[data,setData]=useState<Payload|null>(null),[error,setError]=useState(""),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
 const[draft,setDraft]=useState<PeriodDraft>({start:"",end:""});
 useEffect(()=>{let active=true;void load({start:"",end:""}).then(x=>{if(active)setData(x);}).catch(e=>{if(active)setError(e instanceof Error?e.message:String(e));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[]);
 async function apply(){setBusy(true);setError("");try{setData(await load(draft));}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
 if(loading)return <main style={{padding:32}}><h1>People reports</h1><p role="status">Loading reports…</p></main>;
 if(error||!data)return <main style={{padding:32,maxWidth:760,margin:"0 auto"}}><h1 style={{fontSize:28,fontWeight:700,marginBottom:16}}>People reports unavailable</h1><p role="alert">{error||"No report was returned."}</p><button onClick={()=>window.location.reload()} style={{minHeight:44,padding:"10px 18px",border:"1px solid #4b168c",borderRadius:10,background:"#4b168c",color:"white",margin:"16px 0"}}>Try again</button><p><Link href="/team">Team sign-in and home</Link></p></main>;
 return <PeopleReportsScreen data={data} busy={busy} draft={draft} onDraft={setDraft} onApply={()=>void apply()}/>;
}
