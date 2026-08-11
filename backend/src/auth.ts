import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { RequestActor, Role } from "./domain.js";

const roles:Role[]=["customer","provider","sales","operations","finance","city_admin","super_admin","auditor"];
interface SessionClaims extends RequestActor { issuedAt:number; expiresAt:number; sessionId:string; }

function base64url(value:string|Buffer){return Buffer.from(value).toString("base64url");}
function secret(){const value=process.env.API_SECRET;if(!value||value.length<32)throw new Error("API_SECRET must contain at least 32 characters in token mode");return value;}

export function issueSession(actor:RequestActor,ttlSeconds=3600){
  const claims:SessionClaims={...actor,issuedAt:Math.floor(Date.now()/1000),expiresAt:Math.floor(Date.now()/1000)+ttlSeconds,sessionId:randomUUID()};
  const body=base64url(JSON.stringify(claims));
  const signature=createHmac("sha256",secret()).update(body).digest("base64url");
  return {accessToken:`${body}.${signature}`,expiresAt:new Date(claims.expiresAt*1000).toISOString(),sessionId:claims.sessionId};
}

export function verifySession(token:string):RequestActor{
  const [body,provided]=token.split(".");
  if(!body||!provided)throw Object.assign(new Error("Malformed access token"),{statusCode:401});
  const expected=createHmac("sha256",secret()).update(body).digest();
  const actual=Buffer.from(provided,"base64url");
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Object.assign(new Error("Invalid access token"),{statusCode:401});
  const claims=JSON.parse(Buffer.from(body,"base64url").toString("utf8")) as SessionClaims;
  if(claims.expiresAt<=Math.floor(Date.now()/1000))throw Object.assign(new Error("Access token expired"),{statusCode:401});
  if(!roles.includes(claims.role))throw Object.assign(new Error("Invalid token role"),{statusCode:401});
  return {id:claims.id,role:claims.role,cityId:claims.cityId};
}

export function authenticate(request:FastifyRequest):RequestActor{
  if(process.env.AUTH_MODE!=="token"){
    if(process.env.NODE_ENV==="production")throw Object.assign(new Error("Header-trust authentication is disabled in production; deploy with AUTH_MODE=token and signed sessions"),{statusCode:500});
    const role=String(request.headers["x-role"]??"customer") as Role;
    if(!roles.includes(role))throw Object.assign(new Error("Invalid role"),{statusCode:401});
    return {id:String(request.headers["x-user-id"]??"anonymous"),role,cityId:String(request.headers["x-city-id"]??"blr")};
  }
  const authorization=request.headers.authorization;
  if(!authorization?.startsWith("Bearer "))throw Object.assign(new Error("Bearer token required"),{statusCode:401});
  return verifySession(authorization.slice(7));
}
