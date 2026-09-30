/** Deterministic urgency routing only. No diagnosis, treatment, booking, call or dispatch. */
const PET_EMERGENCY = /\b(?:not breathing|cannot breathe|can['’]?t breathe|struggling to breathe|difficulty breathing|trouble breathing|seizure|collapsed|unconscious|uncontrolled bleeding|bleeding heavily|poisoned|poisoning|severe trauma)\b/i;
export function needsImmediateVetGuidance(message:string){return PET_EMERGENCY.test(String(message||""));}
/** A request for information does not authorize queuing a staff request or contacting anyone. */
export function emergencyGuidanceOnly(message:string){return needsImmediateVetGuidance(message)&&/\b(?:hypothetical|information[- ]only|just explain)\b|(?:do not|don['’]?t|without)\b[\s\S]{0,100}\b(?:contact|create|call|dispatch|book|request)\b/i.test(message);}
// Reuses the published veterinary page's emergency direction; never waits for lead qualification.
export const IMMEDIATE_VET_GUIDANCE="Please don't wait for a response here — contact your nearest emergency vet immediately. PawSpace chat cannot diagnose or treat your pet. No call, booking or dispatch has been made by this reply.";
export function emergencyChatResponse(sessionKey?:string){return{sessionKey,bot:{text:IMMEDIATE_VET_GUIDANCE,choices:[],inputHint:null},ai:{providerConnected:false,turn:{output:IMMEDIATE_VET_GUIDANCE,provider:"deterministic_emergency_guidance",modelRef:null,outcome:"emergency_guidance",handoffReason:"safety"}},customerDataAccess:false,toolExecution:false,autonomousExecution:false,callbackAutomation:false};}
