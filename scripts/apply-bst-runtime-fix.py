from pathlib import Path
# Applies the product compatibility patch, then the workflow validates and removes this temporary runner.
p=Path('app/api/canonical-bookings/route.ts');s=p.read_text()
def r(old,new):
 global s
 if old not in s: raise SystemExit(f'missing: {old[:120]}')
 s=s.replace(old,new)
if 'sitting-payment-governance' not in s:
 lines=s.splitlines()
 idx=next((i for i,line in enumerate(lines) if 'sitting-governance' in line),None)
 if idx is None: raise SystemExit('missing sitting-governance import')
 lines.insert(idx+1,'import {requireSittingQuoteSandboxCapture} from "../../../lib/sitting-payment-governance";')
 s='\n'.join(lines)+'\n'
r('  let sittingCommercial:Awaited<ReturnType<typeof governSittingBooking>>|null=null;','  let sittingCommercial:Awaited<ReturnType<typeof governSittingBooking>>|null=null;\n  let sittingCapture:Awaited<ReturnType<typeof requireSittingQuoteSandboxCapture>>|null=null;')
r('    sittingCommercial=await governSittingBooking(db,{quoteId,packageCode:input.packageCode,packageName:input.packageName,petCount:input.pets.length,cityId:input.cityId,zoneId:input.zoneId,scheduledStart:input.scheduledStart,scheduledEnd:input.scheduledEnd,submittedTotal:input.totalAmount,submittedAmountDueNow:input.amountDueNow,paymentMode:input.payment.mode,paymentStatus:paymentStatusRecorded,reservationCount:reservations.results.length});','    if(paymentStatusRecorded==="captured")sittingCapture=await requireSittingQuoteSandboxCapture(db,{quoteId,amount:input.amountDueNow});\n    sittingCommercial=await governSittingBooking(db,{quoteId,packageCode:input.packageCode,packageName:input.packageName,petCount:input.pets.length,cityId:input.cityId,zoneId:input.zoneId,scheduledStart:input.scheduledStart,scheduledEnd:input.scheduledEnd,submittedTotal:input.totalAmount,submittedAmountDueNow:input.amountDueNow,paymentMode:input.payment.mode,paymentStatus:sittingCapture?.status??paymentStatusRecorded,reservationCount:reservations.results.length});')
r('const paymentStatusPersisted=paymentStatusRecorded;','const paymentStatusPersisted=sittingCapture?.status??paymentStatusRecorded;')
s=s.replace('sittingPaymentReference:undefined','sittingPaymentReference:sittingCapture?.reference')
p.write_text(s)
