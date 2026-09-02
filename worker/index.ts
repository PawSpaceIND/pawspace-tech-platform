/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { auditApiResponse, authorizeApiRequest } from "../lib/api-gateway";
import{authorizePlatformSessionRequest}from"../lib/session-api-gateway";
import{blockDisabledServiceRequest}from"../lib/service-control";
import {runBackgroundScheduler} from "../lib/background-scheduler";
import {runCommunicationOutboxDispatcher} from "../lib/communication-outbox-dispatcher";
import {runServiceRecoveryAudioBotSweep} from "../lib/service-recovery-audio-bot";
import {processDueWhatsAppNoResponseSequences} from "../lib/whatsapp-no-response-sequence";
import {runWhatsAppOutboxDispatcher,syncSubmittedMetaTemplateStatuses} from "../lib/whatsapp-production-runtime";
import {cleanupExpiredReservationLeases} from "../lib/scheduling-reservation-leases";
import {runRazorpayOrderOutboxSweep} from "../lib/razorpay-order-outbox-sweep";
import {runRazorpaySettlementReconciliationSweep} from "../lib/razorpay-settlement-reconciliation";
import {runSubscriptionBillingSweep} from "../lib/subscription-billing";
import {runSubscriptionScheduledMaintenance} from "../lib/subscription-scheduled";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  FOUNDER_EMAIL?: string;
  AI?: unknown;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
  [key:string]:unknown;
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
    ctx.waitUntil((async()=>{
      const [cleanup,scheduler,outboxDispatch,voiceRecovery,whatsappRecovery,whatsappOutbox,templateSync,razorpayOrderOutbox,settlementRecon,subscriptionMaintenance]=await Promise.allSettled([
        cleanupExpiredReservationLeases(env.DB,controller.scheduledTime),
        runBackgroundScheduler(env.DB,{actorId:"system:scheduled-worker",asOf:controller.scheduledTime,cron:controller.cron}),
        runCommunicationOutboxDispatcher(env.DB,env as unknown as Record<string,unknown>,{asOf:controller.scheduledTime}),
        runServiceRecoveryAudioBotSweep(env.DB,{actorId:"system:scheduled-worker",asOf:controller.scheduledTime,env:env as unknown as Record<string,unknown>}),
        processDueWhatsAppNoResponseSequences(env.DB,{now:controller.scheduledTime,actorEmail:"system:scheduled-worker"}),
        runWhatsAppOutboxDispatcher(env.DB,env as unknown as Record<string,unknown>,{asOf:controller.scheduledTime,limit:50}),
        syncSubmittedMetaTemplateStatuses(env.DB,env as unknown as Record<string,unknown>,{actorId:"system:scheduled-worker",limit:50}),
        runRazorpayOrderOutboxSweep(env.DB,env as unknown as Record<string,unknown>,{asOf:controller.scheduledTime,limit:50,workerId:"system:scheduled-worker"}),
        runRazorpaySettlementReconciliationSweep(env.DB,env as unknown as Record<string,unknown>,{asOf:controller.scheduledTime}),
        runSubscriptionScheduledMaintenance(env.DB,env as unknown as Record<string,unknown>,{asOf:controller.scheduledTime,billingSweep:(db,input)=>runSubscriptionBillingSweep(db,input)}),
      ]);
      const errors:string[]=[];
      if(cleanup.status==="rejected")errors.push(`reservation cleanup: ${cleanup.reason instanceof Error?cleanup.reason.message:String(cleanup.reason)}`);
      if(scheduler.status==="rejected")errors.push(`background scheduler: ${scheduler.reason instanceof Error?scheduler.reason.message:String(scheduler.reason)}`);else if(Array.isArray(scheduler.value.errors)&&scheduler.value.errors.length)errors.push(...scheduler.value.errors);
      if(outboxDispatch.status==="rejected")errors.push(`communication outbox dispatcher: ${outboxDispatch.reason instanceof Error?outboxDispatch.reason.message:String(outboxDispatch.reason)}`);else if(outboxDispatch.value.errors.length)errors.push(...outboxDispatch.value.errors.map(error=>`communication outbox dispatcher: ${error}`));
      if(voiceRecovery.status==="rejected")errors.push(`service recovery audio bot: ${voiceRecovery.reason instanceof Error?voiceRecovery.reason.message:String(voiceRecovery.reason)}`);
      if(whatsappRecovery.status==="rejected")errors.push(`whatsapp recovery: ${whatsappRecovery.reason instanceof Error?whatsappRecovery.reason.message:String(whatsappRecovery.reason)}`);
      if(whatsappOutbox.status==="rejected")errors.push(`whatsapp outbox: ${whatsappOutbox.reason instanceof Error?whatsappOutbox.reason.message:String(whatsappOutbox.reason)}`);else if(whatsappOutbox.value.failed)errors.push(`whatsapp outbox: ${whatsappOutbox.value.failed} dispatch exception(s)`);
      if(templateSync.status==="rejected")errors.push(`whatsapp template sync: ${templateSync.reason instanceof Error?templateSync.reason.message:String(templateSync.reason)}`);else if(templateSync.value.failed&&templateSync.value.processed)errors.push(`whatsapp template sync: ${templateSync.value.failed} verification exception(s)`);
      if(razorpayOrderOutbox.status==="rejected")errors.push(`razorpay order outbox: ${razorpayOrderOutbox.reason instanceof Error?razorpayOrderOutbox.reason.message:String(razorpayOrderOutbox.reason)}`);else if(razorpayOrderOutbox.value.failed)errors.push(`razorpay order outbox: ${razorpayOrderOutbox.value.failed} dispatch exception(s)`);
      if(settlementRecon.status==="rejected")errors.push(`razorpay settlement reconciliation: ${settlementRecon.reason instanceof Error?settlementRecon.reason.message:String(settlementRecon.reason)}`);
      if(subscriptionMaintenance.status==="rejected")errors.push(`subscription maintenance: ${subscriptionMaintenance.reason instanceof Error?subscriptionMaintenance.reason.message:String(subscriptionMaintenance.reason)}`);else if(Number(subscriptionMaintenance.value.errors||0)>0)errors.push(`subscription maintenance: ${subscriptionMaintenance.value.errors} exception(s)`);
      if(errors.length)throw new Error(`Background scheduler partial failure: ${errors.join(" | ")}`);
    })());
  },
};

export default worker;
