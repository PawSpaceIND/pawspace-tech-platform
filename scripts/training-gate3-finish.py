from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"Expected patch target missing in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))

# API permissions: customer may request; Finance owns approval/refund policy.
replace_once(
    "lib/api-gateway.ts",
    '  if(url.pathname==="/api/training-finance")return method==="GET"?"finance.view":"finance.manage";',
    '  if(url.pathname==="/api/training-finance")return method==="GET"?"finance.view":"finance.manage";\n  if(url.pathname==="/api/training-cancellation"){const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return String(body.action)==="request"?"scheduling.book":"finance.manage";}\n  if(url.pathname==="/api/training-customer-session-change")return "scheduling.book";'
)
replace_once(
    "lib/session-api-gateway.ts",
    '  if(url.pathname==="/api/training-programmes"&&["GET","POST"].includes(method))return{permission:"scheduling.book",subjectType:"customer"};',
    '  if(url.pathname==="/api/training-programmes"&&["GET","POST"].includes(method))return{permission:"scheduling.book",subjectType:"customer"};\n  if(url.pathname==="/api/training-cancellation"&&method==="POST"){const body=await request.clone().json().catch(()=>({})) as Record<string,unknown>;return String(body.action)==="request"?{permission:"scheduling.book",subjectType:"customer"}:undefined;}\n  if(url.pathname==="/api/training-customer-session-change"&&method==="POST")return{permission:"scheduling.book",subjectType:"customer";};'
)
# Correct accidental syntax in inserted object, if present after substitution above.
p = Path("lib/session-api-gateway.ts")
p.write_text(p.read_text().replace('subjectType:"customer";};','subjectType:"customer"};'))

# Completed-session earnings are receipt-covered, not reversed by later programme cancellation.
replace_once(
    "lib/training-finance.ts",
    'SELECT p.*,b.total_amount,b.currency,b.status booking_status,pay.status payment_status FROM training_programmes p JOIN canonical_bookings b ON b.id=p.booking_id LEFT JOIN booking_payments pay ON pay.booking_id=p.booking_id',
    'SELECT p.*,b.total_amount,b.currency,b.status booking_status,pay.status payment_status,pay.amount_due_now captured_amount FROM training_programmes p JOIN canonical_bookings b ON b.id=p.booking_id LEFT JOIN booking_payments pay ON pay.booking_id=p.booking_id'
)
replace_once(
    "lib/training-finance.ts",
    'const sessions=await db.prepare("SELECT * FROM training_sessions WHERE programme_id=? AND status=\'completed\'").bind(p.id).all<Row>();for(const session of sessions.results){',
    'const sessions=await db.prepare("SELECT * FROM training_sessions WHERE programme_id=? AND status=\'completed\' ORDER BY COALESCE(completed_at,updated_at),sequence_no").bind(p.id).all<Row>();for(const [sessionIndex,session] of sessions.results.entries()){' 
)
replace_once(
    "lib/training-finance.ts",
    'if(rule){gross=Math.round(Number(rule.rate_value)*100)/100;status=String(p.payment_status)==="captured"&&String(p.booking_status)!=="cancelled"?"earned":"held_payment";hold=status==="earned"?null:"Customer payment is not captured or booking is cancelled";}',
    'if(rule){gross=Math.round(Number(rule.rate_value)*100)/100;const captured=String(p.payment_status)==="captured"?Number(p.captured_amount||0):0,perSession=Number(p.total_sessions)>0?Number(p.total_amount||0)/Number(p.total_sessions):Number(p.total_amount||0),requiredCoverage=Math.round(perSession*(sessionIndex+1)*100)/100;status=captured+0.01>=requiredCoverage?"earned":"held_payment";hold=status==="earned"?null:`Captured customer money INR ${captured.toFixed(2)} does not yet cover delivered Training value INR ${requiredCoverage.toFixed(2)}`;}'
)

# A programme cannot be cancelled while a trainer is actively delivering a session.
replace_once(
    "lib/training-cancellation.ts",
    'const row=await context(db,String(caseRow.booking_id)),calc=await calculate(db,row);if(!calc)throw new Response("Training cancellation policy is not configured",{status:409});',
    'const row=await context(db,String(caseRow.booking_id)),inFlight=await db.prepare("SELECT id,status FROM training_sessions WHERE programme_id=? AND status IN (\'arrived\',\'in_session\') LIMIT 1").bind(row.id).first<Row>();if(inFlight)throw new Response(`Training programme cannot be cancelled while session ${String(inFlight.id)} is ${String(inFlight.status)}`,{status:409});const calc=await calculate(db,row);if(!calc)throw new Response("Training cancellation policy is not configured",{status:409});'
)

# Customer recovery controls.
replace_once(
    "app/mobile-app/training-flow.tsx",
    'import { loadTrainingPackages, loadTrainingTrainers, quoteTraining, type TrainingPackage, type TrainingQuote, type TrainingTrainer } from "../../lib/training-commercial-client";',
    'import { loadTrainingPackages, loadTrainingTrainers, quoteTraining, type TrainingPackage, type TrainingQuote, type TrainingTrainer } from "../../lib/training-commercial-client";\nimport { requestTrainingCancellation, requestTrainingSessionReschedule } from "../../lib/training-cancellation-client";'
)
replace_once(
    "app/mobile-app/training-flow.tsx",
    '  const[ledger,setLedger]=useState<CustomerTrainingProgramme|null>(null),[ledgerError,setLedgerError]=useState("");',
    '  const[ledger,setLedger]=useState<CustomerTrainingProgramme|null>(null),[ledgerError,setLedgerError]=useState(""),[recoveryBusy,setRecoveryBusy]=useState(false),[recoveryStatus,setRecoveryStatus]=useState("");'
)
derived = '  const sessions=ledger?.sessions||[],programme=ledger?.programme,completed=sessions.filter(item=>item.status==="completed").length,nextSession=sessions.find(item=>!["completed","cancelled","no_show"].includes(item.status))||null,latestCompleted=[...sessions].reverse().find(item=>item.status==="completed")||null,latestProgress=latestCompleted?jsonObject(latestCompleted.progress_json):{};'
replace_once(
    "app/mobile-app/training-flow.tsx",
    derived,
    derived + '\n  async function requestReschedule(){if(!nextSession)return;const reason=window.prompt("Why do you need to reschedule this Training session?")||"";if(reason.trim().length<8)return;setRecoveryBusy(true);try{const result=await requestTrainingSessionReschedule({bookingId,sessionId:nextSession.id,reason});setRecoveryStatus(`Reschedule request: ${result.status.replaceAll("_"," ")}`);setLedger(await loadTrainingProgramme(bookingId));}catch(problem){setRecoveryStatus(problem instanceof Error?problem.message:"Unable to request reschedule");}finally{setRecoveryBusy(false);}}\n  async function requestCancellation(){const reason=window.prompt("Why are you requesting programme cancellation/refund review?")||"";if(reason.trim().length<8)return;setRecoveryBusy(true);try{const result=await requestTrainingCancellation({bookingId,reason});setRecoveryStatus(result.status==="blocked_policy_configuration"?"Cancellation request recorded; Finance policy configuration is required before a refund can be calculated.":`Cancellation case ${result.caseId}: ${result.status.replaceAll("_"," ")}`);}catch(problem){setRecoveryStatus(problem instanceof Error?problem.message:"Unable to request programme cancellation");}finally{setRecoveryBusy(false);}}'
)
replace_once(
    "app/mobile-app/training-flow.tsx",
    '<p>{nextSession?`${slotLabel(new Date(nextSession.scheduled_start))} · ${serviceMinutes} min · ${nextSession.provider_id}`:"All sessions are terminal or the programme is awaiting recovery."}</p><div><button>Request reschedule</button><button>Message trainer</button></div></article>',
    '<p>{nextSession?`${slotLabel(new Date(nextSession.scheduled_start))} · ${serviceMinutes} min · ${nextSession.provider_id}`:"All sessions are terminal or the programme is awaiting recovery."}</p><div><button disabled={recoveryBusy||!nextSession} onClick={()=>void requestReschedule()}>Request reschedule</button><button>Message trainer</button></div></article>'
)
replace_once(
    "app/mobile-app/training-flow.tsx",
    '<article className={styles.cancelRule}><b>Recovery protection</b><span>Trainer cancellation, replacement, customer cancellation and no-show states remain linked to the same canonical programme. Session consumption changes only through governed lifecycle actions.</span></article>',
    '<article className={styles.cancelRule}><b>Recovery protection</b><span>Trainer cancellation, replacement, customer cancellation and no-show states remain linked to the same canonical programme. Session consumption changes only through governed lifecycle actions.</span><button disabled={recoveryBusy||programme?.status==="completed"||programme?.status==="cancelled"} onClick={()=>void requestCancellation()}>Request programme cancellation / refund review</button>{recoveryStatus&&<small>{recoveryStatus}</small>}</article>'
)

# Team Finance cancellation policy/refund/credit-note controls.
replace_once(
    "app/team/finance/training/page.tsx",
    'type FinanceData={invoices:Row[];earnings:Row[];payouts:Row[];taxPolicies:Row[];compensationRules:Row[];events:Row[];livePayout:false;executionMode:string};',
    'type CancellationFinance={policies:Row[];cases:Row[];refunds:Row[];creditNotes:Row[];liveRefund:false;liveTaxFiling:false};\ntype FinanceData={invoices:Row[];earnings:Row[];payouts:Row[];taxPolicies:Row[];compensationRules:Row[];events:Row[];livePayout:false;executionMode:string;cancellation:CancellationFinance};'
)
issue = 'function issueInvoice(row:Row){const reason=window.prompt(`Issue UAT Training invoice for ${String(row.booking_id)}? Add reason / approval reference.`)||"";if(reason)void action({action:"issue_invoice",bookingId:row.booking_id,reason});}'
replace_once(
    "app/team/finance/training/page.tsx",
    issue,
    issue + 'async function cancellationAction(payload:Record<string,unknown>){setBusy(true);setError("");try{const response=await fetch("/api/training-cancellation",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)}),body=await response.json() as {error?:string};if(!response.ok)throw new Error(body.error||"Training cancellation finance action failed");await load();}catch(problem){setError(problem instanceof Error?problem.message:"Training cancellation finance action failed");}finally{setBusy(false);}}function configureCancellation(){const feeType=window.prompt("Cancellation fee type: none, flat, percent_captured","none")||"",feeValue=feeType==="none"?0:Number(window.prompt(feeType==="flat"?"Flat cancellation fee (INR)":"Cancellation fee % of captured amount")||0),noShowTreatment=window.prompt("No-show treatment for customer refund: chargeable or refundable","chargeable")||"",reason=window.prompt("Policy approval reference / reason")||"";if(["none","flat","percent_captured"].includes(feeType)&&["chargeable","refundable"].includes(noShowTreatment)&&reason)void cancellationAction({action:"configure_policy",cityId:"blr",feeType,feeValue,noShowTreatment,effectiveFrom:new Date().toISOString().slice(0,10),reason});}function approveCancellation(row:Row){const outstanding=Number(row.outstanding_service_value||0),waiveOutstanding=outstanding>0?window.confirm(`Consumed value exceeds captured payment by ${money(outstanding)}. Explicitly waive this outstanding amount to continue?`):false;if(outstanding>0&&!waiveOutstanding)return;const reason=window.prompt(`Approve cancellation for ${String(row.booking_id)}? Calculated refund ${money(row.calculated_refund)}. Add approval reason.`)||"";if(reason)void cancellationAction({action:"approve",caseId:row.id,reason,waiveOutstanding});}function refundStatus(row:Row,nextStatus:string){const providerReference=nextStatus==="completed_sandbox"?window.prompt("Sandbox refund provider/reference ID")||"":undefined,reason=window.prompt(`Move sandbox refund to ${nextStatus.replaceAll("_"," ")}? Add reason.`)||"";if(reason&&(nextStatus!=="completed_sandbox"||providerReference))void cancellationAction({action:"refund_status",caseId:row.case_id,nextStatus,providerReference,reason});}function issueCredit(row:Row){const reason=window.prompt(`Issue UAT credit note for cancellation ${String(row.case_id)}? Add reason.`)||"";if(reason)void cancellationAction({action:"issue_credit_note",caseId:row.case_id,reason});}'
)
replace_once(
    "app/team/finance/training/page.tsx",
    '<button disabled={busy} onClick={configureTax}>Configure tax policy</button><span style={{fontSize:12,color:"#746b7d",alignSelf:"center"}}>No live payout execution. Finance approvals create sandbox-ready instructions only.</span>',
    '<button disabled={busy} onClick={configureTax}>Configure tax policy</button><button disabled={busy} onClick={configureCancellation}>Configure cancellation policy</button><span style={{fontSize:12,color:"#746b7d",alignSelf:"center"}}>No live payout/refund execution. Finance approvals create sandbox-ready instructions only.</span>'
)
payout_marker='<section style={{background:"white",border:"1px solid #e5dcef",borderRadius:14,overflow:"hidden",marginBottom:18}}><div style={{padding:16,borderBottom:"1px solid #eee6f5"}}><b>Trainer payout statements</b></div>'
cancel_section='<section style={{background:"white",border:"1px solid #e5dcef",borderRadius:14,overflow:"hidden",marginBottom:18}}><div style={{padding:16,borderBottom:"1px solid #eee6f5"}}><b>Training cancellation & refund cases</b> · <small>{label(data?.cancellation.policies[0]?.status||"configuration_required")}</small></div><div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}><thead><tr>{["Booking","Usage","Captured","Calculated refund","Outstanding","Status","Action"].map(h=><th key={h} style={{textAlign:"left",padding:11}}>{h}</th>)}</tr></thead><tbody>{data?.cancellation.cases.map(row=><tr key={String(row.id)}><td style={{padding:11}}>{String(row.booking_id)}</td><td style={{padding:11}}>{String(row.chargeable_sessions)}/{String(row.total_sessions)} chargeable</td><td style={{padding:11}}>{money(row.captured_amount)}</td><td style={{padding:11}}>{money(row.calculated_refund)}</td><td style={{padding:11}}>{money(row.outstanding_service_value)}</td><td style={{padding:11}}>{label(row.status)}</td><td style={{padding:11}}><button disabled={busy||!["calculated","calculated_outstanding_review"].includes(String(row.status))} onClick={()=>approveCancellation(row)}>Approve</button></td></tr>)}</tbody></table></div>{data?.cancellation.refunds.map(row=><div key={String(row.id)} style={{padding:12,borderTop:"1px solid #eee6f5"}}><b>{String(row.booking_id)} · {money(row.amount)}</b> · {label(row.status)} <button disabled={busy||!["instruction_ready_sandbox","failed_sandbox"].includes(String(row.status))} onClick={()=>refundStatus(row,"processing_sandbox")}>Process sandbox</button> <button disabled={busy||String(row.status)!=="processing_sandbox"} onClick={()=>refundStatus(row,"completed_sandbox")}>Complete sandbox</button></div>)}{data?.cancellation.creditNotes.map(row=><div key={String(row.id)} style={{padding:12,borderTop:"1px solid #eee6f5"}}><b>Credit note · {money(row.amount)}</b> · {String(row.credit_note_number||label(row.status))} <button disabled={busy||Boolean(row.credit_note_number)||String(row.status)!=="draft_ready_for_number"} onClick={()=>issueCredit(row)}>Issue UAT credit note</button></div>)}</section>'
replace_once("app/team/finance/training/page.tsx", payout_marker, cancel_section+payout_marker)

print("Training Gate 3 final patch applied")
