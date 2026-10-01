import {authError,authFailure,authorize,database} from '../../../lib/server-auth';
import {resolveManagerOrganizationalScope} from '../../../lib/organizational-scope';
import {automationDecision} from '../../../lib/crm-automation-governance';
import {hasPermission} from '../../../lib/platform-security';
import {authorizeCustomerSalesBriefRecord,collectCustomerSalesBrief} from '../../../lib/customer-sales-brief-source';
import {salesBriefServiceCode} from '../../../lib/customer-sales-brief-overrides';

/** Advisory evidence read only. Unknown contact eligibility cannot authorize dispatch. */
export async function GET(request:Request){try{
 const url=new URL(request.url);
 if([...url.searchParams.keys()].some(key=>!['customerId','serviceCode','channel'].includes(key)))throw authFailure('Only customer and service may be requested',400);
 const customerId=url.searchParams.get('customerId')?.trim();
 if(!customerId||customerId.length>200)throw authFailure('Customer ID is required',400);
 const serviceCode=salesBriefServiceCode(url.searchParams.get('serviceCode'));
 const channel=url.searchParams.get('channel')??'voice';
 if(!['voice','whatsapp','sms','email'].includes(channel))throw authFailure('Supported contact channel is required',400);
 const actor=await authorize(request,'customers.view'),db=await database();
 const scope=await resolveManagerOrganizationalScope(db,actor);
 await authorizeCustomerSalesBriefRecord(db,{actor,scope,customerId});
 const checkedAt=Date.now();
 let contactDecision={allowed:false,reason:'contact_source_unavailable',checkedAt,nextEligibleAt:null as number|null};
 if(!hasPermission(actor.permissions,channel==='voice'?'communications.call':'communications.message'))contactDecision.reason='contact_permission_missing';
 else try{
  const decision=await automationDecision(db,{customerId,purpose:'marketing',channel,now:checkedAt},{readOnly:true});
  contactDecision={allowed:decision.allowed,reason:decision.reason,checkedAt,nextEligibleAt:decision.nextEligibleAt};
 }catch{/* Failed canonical policy reads remain unavailable; no allow or dispatch is invented. */}
 const data=await collectCustomerSalesBrief(db,{actor,scope,customerId,serviceCode,asOf:Date.now(),contactChannel:channel,contactDecision});
 return Response.json({data,capabilities:{editOverrides:hasPermission(actor.permissions,'customers.manage')},contactChannel:channel},{headers:{'cache-control':'no-store'}});
}catch(error){return authError(error,'Unable to load customer sales brief');}}
