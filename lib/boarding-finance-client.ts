export type BoardingCustomerFinanceAction="request_cancel"|"request_date_change";

type BoardingFinanceRequest={bookingId:string;action:BoardingCustomerFinanceAction;idempotencyKey:string;reason:string;requestedStart?:string;requestedEnd?:string};

async function parse(response:Response){const payload=await response.json().catch(()=>({})) as Record<string,unknown>;if(!response.ok)throw new Error(String(payload.error||"Unable to update Boarding booking"));return payload.data as Record<string,unknown>;}

export async function requestBoardingFinanceChange(input:BoardingFinanceRequest){return parse(await fetch("/api/boarding-finance",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)}));}
