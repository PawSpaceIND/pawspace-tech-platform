import {handleMoonshotTelemetry} from "../../../../../lib/mas/phase3/moonshot-pipelines";
export async function POST(request:Request){const{env}=await import("cloudflare:workers");return handleMoonshotTelemetry(request,env as never);}
