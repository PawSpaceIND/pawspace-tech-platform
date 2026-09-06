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
import {runEliteScheduledHooks,runEliteWebhookHooks} from "../lib/services/elite-runtime";
import {runMarketingConnectorScheduler} from "../lib/google-ads-conversion-consent";
import {runDiamondCrmScheduledSweep} from "../lib/diamond-crm-scheduler";
import {EXOTEL_AGENTSTREAM_PATH,handleExotelAgentStream} from "../lib/exotel-agentstream";
import {runVoiceCarrierUatScheduler} from "../lib/voice-carrier-uat-scheduler";
import {runTrustSafetySweep} from "../lib/trust-safety-governance";
import {handleAiVoiceSelfTestNegotiate,handleAiVoiceSelfTestStream} from "../lib/voice-ai-self-test";
import {handleDirectBrowserVoiceHarnessStream} from "../lib/voice-ai-browser-harness";
import {ensureFinancialRuntimeSchema} from "../lib/financial-runtime-bootstrap";

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

    // Carrier traffic remains outside PawSpace browser/session auth. The AgentStream handler performs
    // its own carrier authentication and no unrelated finance DDL runs before that identity is checked.
    if(url.pathname===EXOTEL_AGENTSTREAM_PATH)return handleExotelAgentStream(request,env,ctx);
    if(url.pathname==="/voice/ai-self-test"&&url.searchParams.get("mode")==="direct")return handleDirectBrowserVoiceHarnessStream(request,env as unknown as Record<string,unknown>);
    // Provider-authenticated websocket lane. Exotel cannot carry a PawSpace staff cookie, so this path
    // authenticates with the short-lived HMAC in lib/voice-ai-self-test and is UAT-only/allow-list-only.
    if(url.pathname==="/voice/ai-self-test/negotiate")return handleAiVoiceSelfTestNegotiate(request,env as unknown as Record<string,unknown>);
    if(url.pathname==="/voice/ai-self-test")return handleAiVoiceSelfTestStream(request,env as unknown as Record<string,unknown>);

    if (url.pathname.startsWith("/api/")) {
      if(url.pathname==="/api/identity-session")return secureApiResponse(await handler.fetch(request,env,ctx));
      const isMetaWebhook=url.pathname==="/api/whatsapp/meta-webhook";
      const isEmailWebhook=url.pathname==="/api/email-provider-webhook";
      const isDiallerWebhook=url.pathname==="/api/dialler/callback";
      const isProviderWebhook=isMetaWebhook||isEmailWebhook||isDiallerWebhook;
      // Provider webhooks are authenticated inside their route by HMAC/challenge verification, not by
      // a PawSpace user session. Meta additionally feeds the Elite observer after its response.
      const eliteRequest=isMetaWebhook?request.clone():null;
      if(request.method==="POST"&&(url.pathname==="/api/uat-scheduling"||url.pathname==="/api/canonical-bookings"))await cleanupExpiredReservationLeases(env.DB);
      const inspectionRequest=request.clone();
      const sessionAccess=await authorizePlatformSessionRequest(inspectionRequest,env.DB);
      if(sessionAccess instanceof Response)return sessionAccess;
      const providerEmail=isMetaWebhook?"meta-webhook@provider":isEmailWebhook?"email-webhook@provider":"dialler-webhook@provider";
      const access=isProviderWebhook
        ?{actor:{email:providerEmail,roleCode:"provider_webhook",permissions:[],preview:false},permission:null}
        :sessionAccess??await authorizeApiRequest(inspectionRequest, env);
      if (access instanceof Response) return access;
      const serviceBlock=await blockDisabledServiceRequest(inspectionRequest,env.DB);
      if(serviceBlock){ctx.waitUntil(auditApiResponse(env,access.actor,access.permission,inspectionRequest,serviceBlock.clone()));return secureApiResponse(serviceBlock);}

      // Only an accepted application request establishes the finance runtime schema invariant.
      await ensureFinancialRuntimeSchema(env.DB);
      const response = await handler.fetch(request, env, ctx);
      if(isMetaWebhook&&eliteRequest)ctx.waitUntil(runEliteWebhookHooks(env.DB,env as unknown as Record<string,unknown>,eliteRequest,response.clone()).catch(()=>undefined));
      ctx.waitUntil(auditApiResponse(env, access.actor, access.permission, inspectionRequest, response.clone()));
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
      // Scheduled money work can be the first invocation after deploy, so establish the finance schema
      // before any concurrent money/reconciliation sweep begins.
      await ensureFinancialRuntimeSchema(env.DB);
      /* SCOPED, not global. This guard used to `throw` sequentially BEFORE the Promise.allSettled below,
       * so a WhatsApp template verification exception stopped every one of the sweeps that follow from
       * starting at all - including razorpayOrderOutbox, settlementRecon and subscriptionMaintenance. A
       * messaging hiccup silently halted payment reconciliation, and per the audit there is no alerting
       * to notice it.
       *
       * The guard's intent is kept exactly where it belongs: an unverified template must not be sent on,
       * so BOTH WhatsApp dispatch sweeps are blocked below when this is set. Sweeps that send no WhatsApp
       * message are unaffected. The failure still surfaces - it joins the same errors[] aggregation as
       * every other sweep and still fails the invocation at the end. [AUDIT-H9] */
      let templateSyncError:string|null=null;
      try{
        const templateSync=await syncSubmittedMetaTemplateStatuses(env.DB,env as unknown as Record<string,unknown>,{actorId:"system:scheduled-worker",limit:50});
        if(templateSync.failed&&templateSync.processed)templateSyncError=`whatsapp template sync: ${templateSync.failed} verification exception(s)`;
      }catch(error){templateSyncError=`whatsapp template sync: ${error instanceof Error?error.message:String(error)}`;}
      /* Blocked before dispatch: whatsapp template sync failed. Scoped to the WhatsApp senders only. */
      const whatsappDispatchBlocked=templateSyncError?`blocked before dispatch: ${templateSyncError}`:null;
      const skippedWhatsAppSweep=(reason:string)=>Promise.resolve({processed:0,dispatched:0,skipped:0,failed:0,results:[] as unknown[],externalDelivery:false,blocked:reason});
      const marketingHour=Number(new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Kolkata",hour:"2-digit",hour12:false}).format(new Date(controller.scheduledTime)));
      const marketingTask=marketingHour>=6
        ?runMarketingConnectorScheduler(env.DB,{asOf:controller.scheduledTime,runtime:env as unknown as Record<string,unknown>}).then(result=>{const failedSync=Array.isArray(result.sync)?result.sync.filter(item=>String((item as Record<string,unknown>).status)==="failed"):[];const offline=result.offlineConversions as Record<string,unknown>;if(failedSync.length||String(offline?.status||"")==="failed")throw new Error(`provider sync/upload failure: ${JSON.stringify({failedSync,offline})}`);return result;})
        :Promise.resolve({status:"not_due_before_06_ist"});
      const [cleanup,scheduler,outboxDispatch,voiceRecovery,whatsappRecovery,whatsappOutbox,razorpayOrderOutbox,settlementRecon,subscriptionMaintenance,marketingConnector,eliteRuntime,diamondCrm,voiceCarrierUat,trustSafety]=await Promise.allSettled([
        cleanupExpiredReservationLeases(env.DB,controller.scheduledTime),
        runBackgroundScheduler(env.DB,{actorId:"system:scheduled-worker",asOf:controller.scheduledTime,cron:controller.cron}),
        runCommunicationOutboxDispatcher(env.DB,env as unknown as Record<string,unknown>,{asOf:controller.scheduledTime}),
        runServiceRecoveryAudioBotSweep(env.DB,{actorId:"system:scheduled-worker",asOf:controller.scheduledTime,env:env as unknown as Record<string,unknown>}),
        whatsappDispatchBlocked?skippedWhatsAppSweep(whatsappDispatchBlocked):processDueWhatsAppNoResponseSequences(env.DB,{now:controller.scheduledTime,actorEmail:"system:scheduled-worker"}),
        whatsappDispatchBlocked?skippedWhatsAppSweep(whatsappDispatchBlocked):runWhatsAppOutboxDispatcher(env.DB,env as unknown as Record<string,unknown>,{asOf:controller.scheduledTime,limit:50}),
        runRazorpayOrderOutboxSweep(env.DB,env as unknown as Record<string,unknown>,{asOf:controller.scheduledTime,limit:50,workerId:"system:scheduled-worker"}),
        runRazorpaySettlementReconciliationSweep(env.DB,env as unknown as Record<string,unknown>,{asOf:controller.scheduledTime}),
        runSubscriptionScheduledMaintenance(env.DB,env as unknown as Record<string,unknown>,{asOf:controller.scheduledTime,billingSweep:(db,input)=>runSubscriptionBillingSweep(db,input)}),
        marketingTask,
        runEliteScheduledHooks(env.DB,{asOf:controller.scheduledTime}),
        runDiamondCrmScheduledSweep(env.DB,env as unknown as Record<string,unknown>,{asOf:controller.scheduledTime,actorId:"system:scheduled-worker"}),
        runVoiceCarrierUatScheduler(env.DB,env as unknown as Record<string,unknown>,controller.scheduledTime),
        runTrustSafetySweep(env.DB,env as unknown as Record<string,unknown>,{asOf:controller.scheduledTime}),
      ]);
      const errors:string[]=[];
      if(cleanup.status==="rejected")errors.push(`reservation cleanup: ${cleanup.reason instanceof Error?cleanup.reason.message:String(cleanup.reason)}`);
      if(scheduler.status==="rejected")errors.push(`background scheduler: ${scheduler.reason instanceof Error?scheduler.reason.message:String(scheduler.reason)}`);else if(Array.isArray(scheduler.value.errors)&&scheduler.value.errors.length)errors.push(...scheduler.value.errors);
      if(outboxDispatch.status==="rejected")errors.push(`communication outbox dispatcher: ${outboxDispatch.reason instanceof Error?outboxDispatch.reason.message:String(outboxDispatch.reason)}`);else if(outboxDispatch.value.errors.length)errors.push(...outboxDispatch.value.errors.map(error=>`communication outbox dispatcher: ${error}`));
      if(voiceRecovery.status==="rejected")errors.push(`service recovery audio bot: ${voiceRecovery.reason instanceof Error?voiceRecovery.reason.message:String(voiceRecovery.reason)}`);
      if(whatsappRecovery.status==="rejected")errors.push(`whatsapp recovery: ${whatsappRecovery.reason instanceof Error?whatsappRecovery.reason.message:String(whatsappRecovery.reason)}`);
      if(whatsappOutbox.status==="rejected")errors.push(`whatsapp outbox: ${whatsappOutbox.reason instanceof Error?whatsappOutbox.reason.message:String(whatsappOutbox.reason)}`);else if(whatsappOutbox.value.failed)errors.push(`whatsapp outbox: ${whatsappOutbox.value.failed} dispatch exception(s)`);
      if(razorpayOrderOutbox.status==="rejected")errors.push(`razorpay order outbox: ${razorpayOrderOutbox.reason instanceof Error?razorpayOrderOutbox.reason.message:String(razorpayOrderOutbox.reason)}`);else if(razorpayOrderOutbox.value.failed)errors.push(`razorpay order outbox: ${razorpayOrderOutbox.value.failed} dispatch exception(s)`);
      if(settlementRecon.status==="rejected")errors.push(`razorpay settlement reconciliation: ${settlementRecon.reason instanceof Error?settlementRecon.reason.message:String(settlementRecon.reason)}`);
      if(subscriptionMaintenance.status==="rejected")errors.push(`subscription maintenance: ${subscriptionMaintenance.reason instanceof Error?subscriptionMaintenance.reason.message:String(subscriptionMaintenance.reason)}`);else if(Number(subscriptionMaintenance.value.errors||0)>0)errors.push(`subscription maintenance: ${subscriptionMaintenance.value.errors} exception(s)`);
      if(marketingConnector.status==="rejected")errors.push(`marketing connector: ${marketingConnector.reason instanceof Error?marketingConnector.reason.message:String(marketingConnector.reason)}`);
      if(eliteRuntime.status==="rejected")errors.push(`elite runtime: ${eliteRuntime.reason instanceof Error?eliteRuntime.reason.message:String(eliteRuntime.reason)}`);else if(Number(eliteRuntime.value.failed||0)>0)errors.push(`elite runtime: ${eliteRuntime.value.failed} churn scoring exception(s)`);
      if(diamondCrm.status==="rejected")errors.push(`diamond crm: ${diamondCrm.reason instanceof Error?diamondCrm.reason.message:String(diamondCrm.reason)}`);
      if(voiceCarrierUat.status==="rejected")errors.push(`voice carrier UAT: ${voiceCarrierUat.reason instanceof Error?voiceCarrierUat.reason.message:String(voiceCarrierUat.reason)}`);
      if(trustSafety.status==="rejected")errors.push(`trust safety: ${trustSafety.reason instanceof Error?trustSafety.reason.message:String(trustSafety.reason)}`);
      if(templateSyncError)errors.push(templateSyncError);
      if(errors.length)throw new Error(`Background scheduler partial failure: ${errors.join(" | ")}`);
    })());
  },
};

export default worker;