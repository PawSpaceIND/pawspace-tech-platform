from pathlib import Path
p=Path('app/api/canonical-bookings/route.ts');s=p.read_text()
def r(old,new):
 global s
 if old not in s: raise SystemExit(f'missing: {old[:100]}')
 s=s.replace(old,new)
r('import{governSittingBooking,sittingQuoteLinkStatement}from"../../../lib/sitting-governance";','import{governSittingBooking,sittingQuoteLinkStatement}from"../../../lib/sitting-governance";\nimport {requireSittingQuoteSandboxCapture} from "../../../lib/sitting-payment-governance";')
r('  let sittingCommercial:Awaited<ReturnType<typeof governSittingBooking>>|null=null;','  let sittingCommercial:Awaited<ReturnType<typeof governSittingBooking>>|null=null;\n  let sittingCapture:Awaited<ReturnType<typeof requireSittingQuoteSandboxCapture>>|null=null;')
r('    sittingCommercial=await governSittingBooking(db,{quoteId,packageCode:input.packageCode,packageName:input.packageName,petCount:input.pets.length,cityId:input.cityId,zoneId:input.zoneId,scheduledStart:input.scheduledStart,scheduledEnd:input.scheduledEnd,submittedTotal:input.totalAmount,submittedAmountDueNow:input.amountDueNow,paymentMode:input.payment.mode,paymentStatus:paymentStatusRecorded,reservationCount:reservations.results.length});','    if(paymentStatusRecorded==="captured")sittingCapture=await requireSittingQuoteSandboxCapture(db,{quoteId,amount:input.amountDueNow});\n    sittingCommercial=await governSittingBooking(db,{quoteId,packageCode:input.packageCode,packageName:input.packageName,petCount:input.pets.length,cityId:input.cityId,zoneId:input.zoneId,scheduledStart:input.scheduledStart,scheduledEnd:input.scheduledEnd,submittedTotal:input.totalAmount,submittedAmountDueNow:input.amountDueNow,paymentMode:input.payment.mode,paymentStatus:sittingCapture?.status??paymentStatusRecorded,reservationCount:reservations.results.length});')
r('const paymentStatusPersisted=paymentStatusRecorded;','const paymentStatusPersisted=sittingCapture?.status??paymentStatusRecorded;')
s=s.replace('sittingPaymentReference:undefined','sittingPaymentReference:sittingCapture?.reference')
p.write_text(s)
