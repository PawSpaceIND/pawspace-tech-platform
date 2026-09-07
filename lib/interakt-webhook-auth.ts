type Env=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();
const safeEqual=(left:string,right:string)=>{if(left.length!==right.length)return false;let diff=0;for(let i=0;i<left.length;i++)diff|=left.charCodeAt(i)^right.charCodeAt(i);return diff===0;};
async function hmacHex(raw:string,secret:string){const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);const sig=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(raw));return Array.from(new Uint8Array(sig)).map(byte=>byte.toString(16).padStart(2,"0")).join("");}

export async function verifyCanonicalInteraktWebhook(rawBody:string,headers:Headers,env:Env){
 const secret=text(env.INTERAKT_WEBHOOK_SECRET);
 if(!secret)return{ok:false as const,status:503,reason:"interakt_webhook_not_configured"};
 const supplied=text(headers.get("interakt-signature")).toLowerCase();
 if(!supplied)return{ok:false as const,status:401,reason:"invalid_interakt_signature"};
 const expected=`sha256=${await hmacHex(rawBody,secret)}`;
 return safeEqual(supplied,expected)?{ok:true as const}:{ok:false as const,status:401,reason:"invalid_interakt_signature"};
}

export async function signCanonicalInteraktWebhook(secret:string,rawBody:string){return`sha256=${await hmacHex(rawBody,secret)}`;}
