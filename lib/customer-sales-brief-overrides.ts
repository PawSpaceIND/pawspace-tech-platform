import {authFailure,type AuthenticatedActor} from './server-auth';
import {hasPermission} from './platform-security';
import type {OrganizationalScope} from './organizational-scope';
import {normalizeLeadServiceCode} from './lead-lifecycle-governance';
import {pawspaceServices} from './service-control';
import {authorizeCustomerSalesBriefRecord} from './customer-sales-brief-source';
import {validateSalesBriefOverride,type SalesOverride} from './customer-sales-brief';

export function salesBriefServiceCode(value:unknown){
 if(typeof value!=='string'||value.length>80)throw authFailure('Known service is required',400);
 const service=normalizeLeadServiceCode(value);
 const supportedServices=new Set(['general_inquiry',...pawspaceServices.map(item=>normalizeLeadServiceCode(item.code))]);
 if(!supportedServices.has(service))throw authFailure('Known service is required',400);
 return service;
}
export type SalesBriefOverrideCommand={action:'set'|'clear';customerId:string;serviceCode:string;dimension:SalesOverride['dimension'];value?:string;reason:string;expiresAt?:number};
/** Existing audit store only. No consent, lifecycle, payment, lead stage or eligibility mutation. */
export async function appendCustomerSalesBriefOverride(db:D1Database,input:{actor:AuthenticatedActor;scope:OrganizationalScope|null;command:SalesBriefOverrideCommand;asOf:number}){
 if(!hasPermission(input.actor.permissions,'customers.manage'))throw authFailure('Permission denied',403);
 const {command,asOf}=input;
 if(!Number.isFinite(asOf)||asOf<0||!command||!['set','clear'].includes(command.action)||typeof command.customerId!=='string'||!command.customerId.trim()||command.customerId.length>200||typeof command.reason!=='string'||command.reason.trim().length<8||command.reason.length>1000||!['readiness','subscriptionPotential','crossSellPotential'].includes(command.dimension))throw authFailure('Explained supported sales override is required',400);
 const serviceCode=salesBriefServiceCode(command.serviceCode);
 await authorizeCustomerSalesBriefRecord(db,{actor:input.actor,scope:input.scope,customerId:command.customerId});
 const id='SBR-'+crypto.randomUUID();
 if(command.action==='set'){
  try{validateSalesBriefOverride({ref:id,customerId:command.customerId,serviceCode,dimension:command.dimension,value:command.value??'',actorId:input.actor.email,createdAt:asOf,observedAt:asOf,expiresAt:command.expiresAt??NaN,reason:command.reason.trim()},asOf);}catch{throw authFailure('Override requires a supported value and expiry within 30 days',400);}
 }else if(command.value!==undefined||command.expiresAt!==undefined)throw authFailure('Clear accepts no replacement value or expiry',400);
 const action=command.action==='set'?'sales_brief_override':'sales_brief_override_clear';
 const detail={serviceCode,dimension:command.dimension,reason:command.reason.trim(),...(command.action==='set'?{value:command.value,expiresAt:command.expiresAt}:{})};
 // The single append is both state and audit: failure cannot leave an unaudited override.
 await db.prepare('INSERT INTO crm_engine_audit_events (id,entity_type,entity_id,action,actor_email,detail_json,created_at) VALUES (?,?,?,?,?,?,?)').bind(id,'customer',command.customerId,action,input.actor.email,JSON.stringify(detail),asOf).run();
 return{id,customerId:command.customerId,serviceCode,dimension:command.dimension,action:command.action,createdAt:asOf};
}
