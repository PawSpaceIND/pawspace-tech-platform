const HOSTS=["api.exotel.com","api.in.exotel.com"];
const clean=value=>String(value||"").trim();
export async function probeExotelRegion({key,token,sid,callerId="",fetcher=fetch,timeoutMs=12000}){
  key=clean(key);token=clean(token);sid=clean(sid);
  if(!key||!token||!sid)throw new Error("Exotel read-only region probe requires API key, token and account SID");
  const auth="Basic "+Buffer.from(`${key}:${token}`).toString("base64");
  const results=[];
  for(const host of HOSTS){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const url=`https://${host}/v1/Accounts/${encodeURIComponent(sid)}/Calls.json?PageSize=1`;
      const response=await fetcher(url,{method:"GET",headers:{authorization:auth,accept:"application/json"},redirect:"manual",signal:controller.signal});
      try{await response.body?.cancel();}catch{}
      results.push({host,status:response.status,authenticated:response.status===200});
    }catch(error){results.push({host,status:0,authenticated:false,errorClass:error?.name||"request_failed"});}
    finally{clearTimeout(timer);}
  }
  const accepted=results.filter(row=>row.authenticated);
  if(accepted.length!==1)throw new Error(`Exotel account region probe was ${accepted.length?"ambiguous":"unresolved"}; statuses ${results.map(r=>`${r.host}:${r.status}`).join(",")}`);
  let callerIdHistoryMatch=null,callerIdHistoryCount=null;
  const caller=clean(callerId);
  if(caller){
    const url=`https://${accepted[0].host}/v1/Accounts/${encodeURIComponent(sid)}/Calls.json?PageSize=1&PhoneNumber=${encodeURIComponent(caller)}`;
    const response=await fetcher(url,{method:"GET",headers:{authorization:auth,accept:"application/json"},redirect:"manual",signal:AbortSignal.timeout(timeoutMs)});
    if(response.status!==200)throw new Error(`Exotel caller-ID history probe failed with HTTP ${response.status}`);
    const body=await response.json();
    const total=Number(body?.Metadata?.Total);
    callerIdHistoryCount=Number.isFinite(total)&&total>=0?total:null;
    callerIdHistoryMatch=callerIdHistoryCount===null?null:callerIdHistoryCount>0;
  }
  return{host:accepted[0].host,statuses:results.map(({host,status})=>({host,status})),callerIdHistoryMatch,callerIdHistoryCount};
}

if(import.meta.url===`file://${process.argv[1]}`){
  const result=await probeExotelRegion({key:process.env.EXOTEL_API_KEY,token:process.env.EXOTEL_API_TOKEN,sid:process.env.EXOTEL_SID||process.env.EXOTEL_ACCOUNT_SID,callerId:process.env.EXOTEL_CALLER_ID});
  console.log(`EXOTEL_REGION_HOST=${result.host}`);
  console.log(`EXOTEL_REGION_STATUSES=${result.statuses.map(r=>`${r.host}:${r.status}`).join(",")}`);
  console.log(`EXOTEL_CALLER_ID_HISTORY_MATCH=${result.callerIdHistoryMatch===null?"unknown":String(result.callerIdHistoryMatch)}`);
  console.log(`EXOTEL_CALLER_ID_HISTORY_COUNT=${result.callerIdHistoryCount===null?"unknown":result.callerIdHistoryCount}`);
}
