// Read-only tester discovery. The app still revalidates ownership, consent and limits.
import {canonicalDialNumber,normalisedDialKey} from '../lib/voice-call-gate.ts';
export function testerCandidateQuery(phone){
 const number=canonicalDialNumber({},phone);
 if(!number)throw Error('Tester number cannot be canonicalised');
 const suffix=normalisedDialKey(number).slice(-4);
 return {sql:'SELECT id,primary_phone,secondary_phone FROM canonical_customers WHERE primary_phone LIKE ? OR secondary_phone LIKE ? LIMIT 101',params:['%'+suffix+'%','%'+suffix+'%']};
}
export function resolveTesterCustomer(rows,phone){
 if(!Array.isArray(rows)||rows.length>100)throw Error('Tester ownership inventory is incomplete');
 const number=canonicalDialNumber({},phone);
 if(!number)throw Error('Tester number cannot be canonicalised');
 const key=normalisedDialKey(number),owners=new Set();
 for(const row of rows){
  for(const raw of [row.primary_phone,row.secondary_phone]){
   const candidate=canonicalDialNumber({},raw);
   if(candidate&&normalisedDialKey(candidate)===key&&row.id)owners.add(String(row.id));
  }
 }
 if(owners.size!==1)throw Error('Tester phone has '+owners.size+' canonical owners; refusing to select or modify an owner');
 return [...owners][0];
}
