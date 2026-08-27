/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { auditApiResponse, authorizeApiRequest } from "../lib/api-gateway";
import {authorizePlatformSessionRequest} from "../lib/session-api-gateway";
import {blockDisabledServiceRequest} from "../lib/service-control";
import {runBackgroundScheduler} from "../lib/background-scheduler";
import {processDueWhatsAppNoResponseSequences} from "../lib/whatsapp-no-response-sequence";
import {cleanupExpiredReservationLeases} from "../lib/scheduling-reservation-leases";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  FOUNDER_EMAIL?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface ScheduledControllerLike {
  scheduledTime: number;
  cron: string;
  noRetry(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

function secureApiResponse(response:Response){const secured=new Response(response.body,response);secured.headers.set("cache-control","no-store");secured.headers.set("x-content-type-options","nosniff");secured.headers.set("referrer-policy","same-origin");return secured;}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      if(url.pathname==="/api/identity-session")return secureApiResponse(await handler.fetch(request,env,ctx));
      if(request.method==="POST"&&(url.pathname==="/api/uat-scheduling"||url.pathname==="/api/canonical-bookings"))await cleanupExpiredReservationLeases(env.DB);
      const sessionAccess=await authorizePlatformSessionRequest(request,env.DB);
      if(sessionAccess instanceof Response)return sessionAccess;
      const access=sessionAccess??await authorizeApiRequest(request, env);
      if (access instanceof Response) return access;
      const serviceBlock=await blockDisabledServiceRequest(request,env.DB);
      if(serviceBlock){ctx.waitUntil(auditApiResponse(env,access.actor,access.permission,request,serviceBlock.clone()));return secureApiResponse(serviceBlock);}
      const response = await handler.fetch(request, env, ctx);
      ctx.waitUntil(auditApiResponse(env, access.actor, access.permission, request, response.clone()));
      return secureApiResponse(response);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
  async scheduled(controller:ScheduledControllerLike,env:Env,ctx:ExecutionContext){
    ctx.waitUntil((async()=>{const [cleanup,scheduler,whatsappRecovery]=await Promise.allSettled([cleanupExpiredReservationLeases(env.DB,controller.scheduledTime),runBackgroundScheduler(env.DB,{actorId:"system:scheduled-worker",asOf:controller.scheduledTime,cron:controller.cron}),processDueWhatsAppNoResponseSequences(env.DB,{now:controller.scheduledTime,actorEmail:"system:scheduled-worker"})]);const errors:string[]=[];if(cleanup.status==="rejected")errors.push(`reservation cleanup: ${cleanup.reason instanceof Error?cleanup.reason.message:String(cleanup.reason)}`);if(scheduler.status==="rejected")errors.push(`background scheduler: ${scheduler.reason instanceof Error?scheduler.reason.message:String(scheduler.reason)}`);else if(Array.isArray(scheduler.value.errors)&&scheduler.value.errors.length)errors.push(...scheduler.value.errors);if(whatsappRecovery.status==="rejected")errors.push(`whatsapp recovery: ${whatsappRecovery.reason instanceof Error?whatsappRecovery.reason.message:String(whatsappRecovery.reason)}`);if(errors.length)throw new Error(`Background scheduler partial failure: ${errors.join(" | ")}`);})());
  },
};

export default worker;
