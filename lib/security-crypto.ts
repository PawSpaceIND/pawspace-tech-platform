const encoder=new TextEncoder();
const CONSTANT_TIME_COMPARE_BYTES=512;

/** Fixed-work string equality for secrets/tokens. Inputs above the bounded comparison size fail closed. */
export function constantTimeEqual(left:unknown,right:unknown){
 const a=encoder.encode(String(left??"")),b=encoder.encode(String(right??""));
 if(a.length>CONSTANT_TIME_COMPARE_BYTES||b.length>CONSTANT_TIME_COMPARE_BYTES)return false;
 let diff=a.length^b.length;
 for(let index=0;index<CONSTANT_TIME_COMPARE_BYTES;index++)diff|=(a[index]??0)^(b[index]??0);
 return diff===0;
}

/** Uniform six-digit OTP generated only from Web Crypto CSPRNG output (rejection sampling avoids modulo bias). */
export function secureSixDigitOtp(){
 const range=900_000,space=0x1_0000_0000,limit=Math.floor(space/range)*range,word=new Uint32Array(1);
 let value=limit;
 while(value>=limit){crypto.getRandomValues(word);value=word[0];}
 return String(100_000+(value%range));
}

/** Per-challenge salt for keyed OTP verifiers. Hex avoids runtime-specific base64 helpers. */
export function randomVerifierSalt(bytes=16){
 const salt=new Uint8Array(Math.max(16,bytes));crypto.getRandomValues(salt);
 return Array.from(salt,byte=>byte.toString(16).padStart(2,"0")).join("");
}
