export const MARKETING_ATTRIBUTION_KEYS=["gclid","wbraid","gbraid","fbclid","utm_source","utm_medium","utm_campaign","utm_content","utm_term"]as const;
export type MarketingAttributionKey=(typeof MARKETING_ATTRIBUTION_KEYS)[number];
export type MarketingAttributionCapture=Partial<Record<MarketingAttributionKey,string>>;
export type MarketingSourcePlatform="google"|"meta"|"other"|"direct";

const MAX_TOKEN_LENGTH=512;
const clean=(value:unknown,max=MAX_TOKEN_LENGTH)=>String(value??"").replace(/[\u0000-\u001F\u007F]/g,"").trim().slice(0,max);

export function normalizeMarketingAttribution(input:Record<string,unknown>|null|undefined):MarketingAttributionCapture{
 const result:MarketingAttributionCapture={};
 if(!input)return result;
 for(const key of MARKETING_ATTRIBUTION_KEYS){const value=clean(input[key]);if(value)result[key]=value;}
 return result;
}

export function parseMarketingAttributionSearch(search:string):MarketingAttributionCapture{
 const params=new URLSearchParams(search.startsWith("?")?search.slice(1):search),raw:Record<string,string>={};
 for(const key of MARKETING_ATTRIBUTION_KEYS){const value=params.get(key);if(value)raw[key]=value;}
 return normalizeMarketingAttribution(raw);
}

/**
 * Browser-only helper. Components call this after mount (for example from useEffect), which keeps
 * the server render deterministic and avoids a query-string hydration mismatch.
 */
export function captureMarketingAttributionFromWindow():MarketingAttributionCapture{
 if(typeof window==="undefined")return{};
 return parseMarketingAttributionSearch(window.location.search);
}

export function hasMarketingAttribution(input:MarketingAttributionCapture){return MARKETING_ATTRIBUTION_KEYS.some(key=>Boolean(clean(input[key])));}

export function inferMarketingSourcePlatform(input:MarketingAttributionCapture):MarketingSourcePlatform{
 if(clean(input.gclid)||clean(input.wbraid)||clean(input.gbraid))return"google";
 if(clean(input.fbclid))return"meta";
 const source=clean(input.utm_source,120).toLowerCase();
 if(["google","googleads","google_ads","adwords"].includes(source))return"google";
 if(["facebook","fb","meta","instagram","ig"].includes(source))return"meta";
 return source?"other":"direct";
}

export function googleAdIdentifier(input:MarketingAttributionCapture):{type:"gclid"|"wbraid"|"gbraid";value:string}|null{
 const gclid=clean(input.gclid);if(gclid)return{type:"gclid",value:gclid};
 const wbraid=clean(input.wbraid);if(wbraid)return{type:"wbraid",value:wbraid};
 const gbraid=clean(input.gbraid);if(gbraid)return{type:"gbraid",value:gbraid};
 return null;
}
