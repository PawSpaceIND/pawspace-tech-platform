import {handleMoonshotVision} from "../../../../../lib/mas/phase3/moonshot-pipelines";
export async function POST(request:Request){const{env}=await import("cloudflare:workers");return handleMoonshotVision(request,env as never);}
