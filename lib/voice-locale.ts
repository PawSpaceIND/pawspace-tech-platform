export type BengaluruVoiceLocale="en-IN"|"hi-IN"|"kn-IN";

export const BENGALURU_VOICE_LOCALES:BengaluruVoiceLocale[]=["en-IN","hi-IN","kn-IN"];
export const DEFAULT_BENGALURU_VOICE_LOCALE:BengaluruVoiceLocale="en-IN";

const ALIASES:Record<string,BengaluruVoiceLocale>={
  "en":"en-IN","en-in":"en-IN","english":"en-IN",
  "hi":"hi-IN","hi-in":"hi-IN","hindi":"hi-IN",
  "kn":"kn-IN","kn-in":"kn-IN","kannada":"kn-IN",
};

export function canonicalVoiceLocale(value:unknown,fallback:BengaluruVoiceLocale=DEFAULT_BENGALURU_VOICE_LOCALE):BengaluruVoiceLocale{
  const key=String(value??"").trim().toLowerCase().replaceAll("_","-");
  return ALIASES[key]||fallback;
}

export function speechLanguageCode(value:unknown):"en"|"hi"|"kn"{
  const locale=canonicalVoiceLocale(value);
  return locale==="hi-IN"?"hi":locale==="kn-IN"?"kn":"en";
}

export type TelephonyCallContext={callRef:string;locale:BengaluruVoiceLocale};

/**
 * Exotel's CustomField is our carrier round-trip envelope. Keep it small and versioned so callbacks can
 * recover both the PawSpace call id and the speech locale. Legacy deployments sent the call id alone;
 * decodeTelephonyCallContext deliberately accepts that old shape and defaults it to Bengaluru English.
 */
export function encodeTelephonyCallContext(callRef:string,locale:unknown):string{
  const ref=String(callRef??"").trim();
  if(!ref)throw new Error("A call reference is required for telephony context");
  return JSON.stringify({v:1,callRef:ref,locale:canonicalVoiceLocale(locale)});
}

export function decodeTelephonyCallContext(value:unknown):TelephonyCallContext{
  const raw=String(value??"").trim();
  if(!raw)return{callRef:"",locale:DEFAULT_BENGALURU_VOICE_LOCALE};
  if(raw.startsWith("{")){
    try{
      const parsed=JSON.parse(raw) as Record<string,unknown>;
      const callRef=String(parsed.callRef??parsed.call_ref??"").trim();
      if(callRef)return{callRef,locale:canonicalVoiceLocale(parsed.locale??parsed.language)};
    }catch{}
  }
  return{callRef:raw,locale:DEFAULT_BENGALURU_VOICE_LOCALE};
}
