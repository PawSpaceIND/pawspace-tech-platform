import {apiSend} from "./api-fetch";
export type CustomerTrainingSession={id:string;programme_id:string;booking_id:string;sequence_no:number;provider_id:string;scheduled_start:string;scheduled_end:string;status:string;attendance_json:string;homework_json:string;progress_json:string;evidence_json:string;started_at:number|null;completed_at:number|null};
export type CustomerTrainingProgramme={programme:{id:string;booking_id:string;provider_id:string;plan_code:string;plan_name:string;status:string;total_sessions:number;completed_sessions:number;no_show_sessions:number;cancelled_sessions:number;meet_booking_id:string|null;pricing_snapshot_json:string};sessions:CustomerTrainingSession[];events:Array<Record<string,unknown>>};
export async function materializeTrainingProgramme(input:{bookingId:string;meetBookingId?:string}){return apiSend<CustomerTrainingProgramme&{duplicatePrevented:boolean}>("/api/training-programmes",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)},"Unable to create Training programme ledger");}
/** Assessments use one execution session, but do not become a customer multi-session programme. */
export async function prepareTrainingProgramme(input:{bookingId:string;packageCode:string;meetBookingId?:string}){
 const record=await materializeTrainingProgramme({bookingId:input.bookingId,meetBookingId:input.meetBookingId});
 return input.packageCode==="trainer-meet-greet"?null:record;
}
export async function loadTrainingProgramme(bookingId:string,signal?:AbortSignal){return apiSend<CustomerTrainingProgramme>(`/api/training-programmes?bookingId=${encodeURIComponent(bookingId)}`,{cache:"no-store",signal},"Unable to load Training programme ledger");}
