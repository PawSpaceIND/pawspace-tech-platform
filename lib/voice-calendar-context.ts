/** Server clock rendered explicitly so the model never has to infer a date from epoch milliseconds. */
export function voiceCalendarContext(now = Date.now()) {
 const timezone = "Asia/Kolkata";
 const date = (value:number) => {
  const parts = new Intl.DateTimeFormat("en-CA", {timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(value);
  const part = (name:string) => parts.find(p=>p.type===name)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
 };
 return {asOf:now,asOfIso:new Date(now).toISOString(),timezone,todayDate:date(now),tomorrowDate:date(now+86_400_000)};
}
