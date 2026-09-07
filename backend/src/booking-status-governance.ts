import type { BookingStatus, Role } from "./domain.js";

const PROVIDER_TRANSITIONS:Readonly<Record<BookingStatus,readonly BookingStatus[]>>=Object.freeze({
  draft:[],
  confirmed:[],
  assigned:["on_the_way"],
  on_the_way:["arrived"],
  arrived:["in_service"],
  in_service:["completed"],
  completed:[],
  cancelled:[],
});

const STAFF_TRANSITIONS:Readonly<Record<BookingStatus,readonly BookingStatus[]>>=Object.freeze({
  draft:["confirmed","cancelled"],
  confirmed:["assigned","cancelled"],
  assigned:["on_the_way","cancelled"],
  on_the_way:["arrived","cancelled"],
  arrived:["in_service","cancelled"],
  in_service:["completed","cancelled"],
  completed:[],
  cancelled:[],
});

export function assertBookingStatusTransition(input:{actorRole:Role;current:BookingStatus;next:BookingStatus}){
  if(input.current===input.next)return;
  const graph=input.actorRole==="provider"?PROVIDER_TRANSITIONS:STAFF_TRANSITIONS;
  if(!graph[input.current].includes(input.next)){
    throw Object.assign(new Error(`Invalid booking status transition ${input.current} -> ${input.next}`),{statusCode:409});
  }
}
