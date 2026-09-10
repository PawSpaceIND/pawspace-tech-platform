import {probeExotelRegion} from "../lib/exotel-region-probe.ts";

const result=await probeExotelRegion({
  key:process.env.EXOTEL_API_KEY,
  token:process.env.EXOTEL_API_TOKEN,
  sid:process.env.EXOTEL_SID||process.env.EXOTEL_ACCOUNT_SID,
  callerId:process.env.EXOTEL_CALLER_ID,
});
console.log(`EXOTEL_REGION_HOST=${result.host}`);
console.log(`EXOTEL_REGION_STATUSES=${result.statuses.map(r=>`${r.host}:${r.status}`).join(",")}`);
console.log(`EXOTEL_CALLER_ID_HISTORY_MATCH=${result.callerIdHistoryMatch===null?"unknown":String(result.callerIdHistoryMatch)}`);
console.log(`EXOTEL_CALLER_ID_HISTORY_COUNT=${result.callerIdHistoryCount===null?"unknown":result.callerIdHistoryCount}`);
