export type TrainingCalendarTerms={sessions:number;validityDays:number;minutesPerSession:number};
export type TrainingCalendarWindow={start:string;end:string};
const DAY=86_400_000;

/** Customer-selected cadence; catalogue duration/validity remain authoritative and unchanged. */
export function trainingCalendarWindows(start:string,terms:TrainingCalendarTerms,cadenceDays=7):TrainingCalendarWindow[]{
 const first=Date.parse(start),{sessions,validityDays,minutesPerSession}=terms;
 if(!Number.isFinite(first)||!Number.isInteger(sessions)||sessions<1||sessions>16||!Number.isInteger(validityDays)||validityDays<1||!Number.isFinite(minutesPerSession)||minutesPerSession<60)throw new Error('A valid Training calendar and published programme are required.');
 if(!Number.isInteger(cadenceDays)||cadenceDays<1||cadenceDays>31)throw new Error('Choose a whole number of days between sessions, from 1 to 31.');
 const duration=minutesPerSession*60_000;
 if((sessions-1)*cadenceDays*DAY+duration>validityDays*DAY){
  const maximum=Math.floor((validityDays*DAY-duration)/Math.max(1,sessions-1)/DAY);
  throw new Error(`This programme must finish within ${validityDays} days. Choose no more than ${maximum} days between sessions.`);
 }
 return Array.from({length:sessions},(_,index)=>({start:new Date(first+index*cadenceDays*DAY).toISOString(),end:new Date(first+index*cadenceDays*DAY+duration).toISOString()}));
}

/** Server-side final check against the actual held calendar, never browser-proposed dates. */
export function assertTrainingCalendarValidity(start:string,terms:TrainingCalendarTerms,windows:TrainingCalendarWindow[]){
 const first=Date.parse(start),deadline=first+terms.validityDays*DAY,duration=terms.minutesPerSession*60_000;
 if(!Number.isFinite(first)||windows.length!==terms.sessions)throw new Error('The reserved Training calendar does not match the programme.');
 const ordered=[...windows].sort((a,b)=>Date.parse(a.start)-Date.parse(b.start));
 if(Date.parse(ordered[0]?.start)!==first)throw new Error('The first reserved Training session has changed.');
 let previousEnd=first;
 for(const window of ordered){
  const from=Date.parse(window.start),to=Date.parse(window.end);
  if(!Number.isFinite(from)||!Number.isFinite(to)||from<previousEnd||to-from!==duration||to>deadline)throw new Error('Reserved Training sessions must retain their duration and finish within the published validity.');
  previousEnd=to;
 }
}
