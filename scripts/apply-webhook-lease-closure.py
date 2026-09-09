#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / "app/api/razorpay-webhook/route.ts"
text = path.read_text()

def one(old: str, new: str):
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"razorpay-webhook route drift: expected one match, found {count}: {old[:140]!r}")
    text = text.replace(old, new, 1)

one(
    'import{finalizeSubscriptionRefundEntitlement,grantSubscriptionRenewalEntitlement,prepareSubscriptionRefundEntitlementForWebhook}from"../../../lib/subscription-entitlement-renewal";\n',
    'import{finalizeSubscriptionRefundEntitlement,grantSubscriptionRenewalEntitlement,prepareSubscriptionRefundEntitlementForWebhook}from"../../../lib/subscription-entitlement-renewal";\nimport{claimWebhookInbox,markWebhookInbox,rejectUnclaimedWebhookInbox}from"../../../lib/webhook-inbox-lease";\n',
)

one(
'''    if(!eventType){await markInbox(db,accepted.row,"REJECTED",undefined,"missing_event_type");return json({error:"Webhook event type is required"},400);}''',
'''    if(!eventType){await rejectUnclaimedWebhookInbox(db,{inboxId:String(accepted.row.id),reason:"missing_event_type"});return json({error:"Webhook event type is required"},400);}''',
)
one(
'''if(!pilot.ok){await markInbox(db,accepted.row,"REJECTED",eventType,"outside_payment_pilot");return json({error:pilot.reason,code:"outside_payment_pilot"},403);}''',
'''if(!pilot.ok){await rejectUnclaimedWebhookInbox(db,{inboxId:String(accepted.row.id),eventType,reason:"outside_payment_pilot"});return json({error:pilot.reason,code:"outside_payment_pilot"},403);}''',
)

old_claim = '''    const recoveringFailedInbox=String(accepted.row.processing_status||"").toUpperCase()==="FAILED";\n    if(!(await claimInbox(db,accepted.row,eventType))){\n      /*\n       * `accepted.row.event_id`, NOT the header's eventId, and that distinction is new.\n       *\n       * The post-commit capture effects are keyed on the event id they were enqueued under, which is the\n       * id of the event as RECORDED. Since the inbox now dedupes on the payload digest, a redelivery can\n       * arrive carrying a different id in the header - a gateway retry, or a replay - and resolve to the\n       * original row. Looking the outbox up by the header id would then find nothing, silently answer\n       * 200, and strand a pending capture effect that the retry existed to finish.\n       */\n      const effects=await retryCaptureEffects(db,String(accepted.row.event_id||eventId));\n      if(effects&&!effects.completed)return json({ok:false,environment:gate.environment,duplicate:true,status:String(accepted.row.processing_status),captureEffectsRetry:true,reason:effects.reason||"capture_post_commit_pending"},503);\n      return json({ok:true,environment:gate.environment,duplicate:true,status:String(accepted.row.processing_status),captureEffectsRecovered:Boolean(effects?.completed)});\n    }'''
new_claim = '''    const captureEvent=targetFor(eventType)==="CAPTURED";\n    let recoveringInbox=false;\n    let inboxClaimToken:string|null=null;\n    if(captureEvent){\n      if(!(await claimInbox(db,accepted.row,eventType))){\n        const effects=await retryCaptureEffects(db,String(accepted.row.event_id||eventId));\n        if(effects&&!effects.completed)return json({ok:false,environment:gate.environment,duplicate:true,status:String(accepted.row.processing_status),captureEffectsRetry:true,reason:effects.reason||"capture_post_commit_pending"},503);\n        return json({ok:true,environment:gate.environment,duplicate:true,status:String(accepted.row.processing_status),captureEffectsRecovered:Boolean(effects?.completed)});\n      }\n    }else{\n      const claim=await claimWebhookInbox(db,{inboxId:String(accepted.row.id),eventType});\n      recoveringInbox=claim.recovered;\n      inboxClaimToken=claim.claimToken;\n      if(!claim.claimed){\n        if(claim.currentStatus.toUpperCase()==="PROCESSING")return json({ok:false,environment:gate.environment,duplicate:true,status:"PROCESSING",reason:"webhook_processing_in_progress"},503);\n        return json({ok:true,environment:gate.environment,duplicate:true,status:claim.currentStatus});\n      }\n    }\n    const finishInbox=async(status:"PROCESSED"|"DEFERRED"|"REJECTED"|"FAILED",type?:string,reason?:string)=>{\n      if(inboxClaimToken){\n        const result=await markWebhookInbox(db,{inboxId:String(accepted.row.id),claimToken:inboxClaimToken,status,eventType:type,reason});\n        if(!result.marked)throw new Error("webhook_inbox_claim_lost");\n        return;\n      }\n      await markInbox(db,accepted.row,status,type,reason);\n    };'''
one(old_claim, new_claim)

# All post-claim terminal writes go through the fencing wrapper.
text = text.replace('await markInbox(db,accepted.row,', 'await finishInbox(')
# The two pre-claim rejection sites were already replaced above and must not have been rewritten.
if 'finishInbox(db,accepted.row' in text:
    raise SystemExit('unexpected finishInbox rewrite shape')

text = text.replace('{allowRecovery:recoveringFailedInbox}', '{allowRecovery:recoveringInbox}')
if 'recoveringFailedInbox' in text:
    raise SystemExit('stale recoveringFailedInbox reference remains')

# Guard the generic success response so a recovered stale path is visible in evidence.
one(
'''      return json({ok:true,environment:gate.environment,...result,paymentState:transition,journal:null});''',
'''      return json({ok:true,environment:gate.environment,...result,paymentState:transition,journal:null,processingRecovered:recoveringInbox});''',
)

path.write_text(text)
