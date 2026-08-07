from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"Expected patch target missing in {path}: {old[:140]!r}")
    p.write_text(text.replace(old, new, 1))

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
    'if(rule){gross=Math.round(Number(rule.rate_value)*100)/100;status=String(p.payment_status)==="captured"?"earned":"held_payment";hold=status==="earned"?null:"Customer payment is not captured";}',
    'if(rule){gross=Math.round(Number(rule.rate_value)*100)/100;const captured=String(p.payment_status)==="captured"?Number(p.captured_amount||0):0,perSession=Number(p.total_sessions)>0?Number(p.total_amount||0)/Number(p.total_sessions):Number(p.total_amount||0),requiredCoverage=Math.round(perSession*(sessionIndex+1)*100)/100;status=captured+0.01>=requiredCoverage?"earned":"held_payment";hold=status==="earned"?null:`Captured customer money INR ${captured.toFixed(2)} does not yet cover delivered Training value INR ${requiredCoverage.toFixed(2)}`;}'
)
replace_once(
    "lib/training-cancellation.ts",
    'const row=await context(db,String(caseRow.booking_id)),calc=await calculate(db,row);if(!calc)throw new Response("Training cancellation policy is not configured",{status:409});',
    'const row=await context(db,String(caseRow.booking_id)),inFlight=await db.prepare("SELECT id,status FROM training_sessions WHERE programme_id=? AND status IN (\'arrived\',\'in_session\') LIMIT 1").bind(row.id).first<Row>();if(inFlight)throw new Response(`Training programme cannot be cancelled while session ${String(inFlight.id)} is ${String(inFlight.status)}`,{status:409});const calc=await calculate(db,row);if(!calc)throw new Response("Training cancellation policy is not configured",{status:409});'
)
print("Training Gate 3 safety patch applied")
