/** Collection eligibility and payment deadline are different: split balances can be paid early. */
export function paymentDeadlineLabel(stage:unknown,balanceDueAt:unknown){
 if(stage!=="outstanding_balance")return stage==="settled"?"No payment outstanding":"Current payment stage";
 const timestamp=Number(balanceDueAt);
 if(!Number.isFinite(timestamp)||timestamp<=0)return "Balance deadline not recorded";
 return `Balance due ${new Intl.DateTimeFormat("en-IN",{day:"2-digit",month:"short",year:"numeric",hour:"numeric",minute:"2-digit",timeZone:"Asia/Kolkata"}).format(new Date(timestamp))} IST`;
}
