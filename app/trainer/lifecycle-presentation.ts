export function trainingVideoValidation(file:{type:string;size:number}){return ["video/mp4","video/webm"].includes(file.type)&&Number.isFinite(file.size)&&file.size>0&&file.size<=10_000_000;}
export function trainingHandoverReminder(remindAt:number|null|undefined,now:number){return Number.isFinite(remindAt)&&Number(remindAt)>0&&now>=Number(remindAt);}
export function trainingHomeworkStatus(status:string|undefined){return status==="acknowledged"?"Pet parent acknowledged the saved homework.":status==="available"?"Saved homework is available in the parent app; parent acknowledgement is pending.":"Save the report to make homework available in the parent app.";}

/** Preserve the exact payload and UUID across an uncertain retry. */
export function trainingChangeRequestRegistry(makeKey:()=>string){const requests=new Map<string,string>();return (payload:Record<string,unknown>)=>{const fingerprint=JSON.stringify(payload);let body=requests.get(fingerprint);if(!body){body=JSON.stringify({...payload,idempotencyKey:makeKey()});requests.set(fingerprint,body);}return body;};}
