import {authError,authFailure,authorize,database} from '../../../../lib/server-auth';
import {resolveManagerOrganizationalScope} from '../../../../lib/organizational-scope';
import {appendCustomerSalesBriefOverride,type SalesBriefOverrideCommand} from '../../../../lib/customer-sales-brief-overrides';

export async function POST(request:Request){try{
 if(request.headers.get('origin')!==new URL(request.url).origin||request.headers.get('sec-fetch-site')==='cross-site')throw authFailure('Same-origin sales override required',403);
 if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw authFailure('JSON body required',415);
 const actor=await authorize(request,'customers.manage'),db=await database();
 let body:unknown;try{body=await request.json();}catch{throw authFailure('Valid JSON body required',400);}
 const keys=['action','customerId','serviceCode','dimension','value','reason','expiresAt'];
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!keys.includes(key)))throw authFailure('Unsupported override fields',400);
 const scope=await resolveManagerOrganizationalScope(db,actor);
 const data=await appendCustomerSalesBriefOverride(db,{actor,scope,command:body as SalesBriefOverrideCommand,asOf:Date.now()});
 return Response.json({data},{status:201,headers:{'cache-control':'no-store'}});
}catch(error){return authError(error,'Unable to save customer sales override');}}
