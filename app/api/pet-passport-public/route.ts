import{database}from"../../../lib/server-auth";
import{getSharedPetPassport}from"../../../lib/pet-passport-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});

// PUBLIC, unauthenticated: anyone with the unguessable share token sees the privacy-safe pet card
// (no owner PII). A missing/revoked token returns 404. This is what a shared social link resolves to.
export async function GET(request:Request){
  try{
    const token=String(new URL(request.url).searchParams.get("token")||"").trim();
    if(!token)return json({error:"A share token is required"},400);
    const db=await database();
    const data=await getSharedPetPassport(db,token);
    if(!data)return json({error:"This pet passport link is invalid or has been revoked"},404);
    return json({data});
  }catch{return json({error:"Unable to load pet passport"},500);}
}
