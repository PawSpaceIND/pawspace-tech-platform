type Row=Record<string,unknown>;
/** Read-only projection of communication-governance's central consent rule.
 * Absence/null channel flags retain that owner's semantics. A failed read is unknown, never allow.
 * No initialization, mutation or dispatch; the scoped collector verifies the customer first.
 */
export async function readSalesBriefCentralConsent(db:D1Database,input:{customerId:string;channel:string}){
 const channelKeys:Record<string,string>={voice:'voice_allowed',whatsapp:'whatsapp_allowed',sms:'sms_allowed',email:'email_allowed'};
 const key=Object.hasOwn(channelKeys,input.channel)?channelKeys[input.channel]:null;
 if(!key)return{status:'unavailable',allowed:null,reason:'contact_channel_unknown'} as const;
 try{
  const row=await db.prepare('SELECT global_opt_out,voice_allowed,whatsapp_allowed,sms_allowed,email_allowed FROM communication_consent WHERE customer_id=?').bind(input.customerId).first<Row>();
  if(row&&Number(row.global_opt_out||0)===1)return{status:'available',allowed:false,reason:'central_global_opt_out'} as const;
  if(row&&row[key]!=null&&Number(row[key])!==1)return{status:'available',allowed:false,reason:'central_channel_refused'} as const;
  return{status:'available',allowed:true,reason:'central_consent_allowed'} as const;
 }catch{return{status:'unavailable',allowed:null,reason:'contact_source_unavailable'} as const;}
}
