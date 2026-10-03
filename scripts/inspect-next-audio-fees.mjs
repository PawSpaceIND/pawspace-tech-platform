import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const REGIONS=['https://api.elevenlabs.io','https://api.in.residency.elevenlabs.io'];
const STAGING_BRAIN='https://pawspace-staging.karthik-fce.workers.dev/api/elevenlabs/v1';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const finite=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
const flag=value=>typeof value==='boolean'?value:null;
const model=value=>typeof value==='string'&&/^[a-z0-9_.:/-]{1,100}$/i.test(value)?value:null;
const count=value=>Array.isArray(value)?value.length:null;
const feature=value=>({present:value!==undefined,state:value===null?'null':typeof value,enabled:flag(object(value).enabled??object(value).is_enabled),configurationSha256:value===undefined?null:hash(value)});
const items=value=>Array.isArray(value)?value.map(x=>({source:['system','user'].includes(x?.source)?x.source:null,itemSha256:hash(x),additionalVersionCount:count(x?.additional_version_ids),modelOverride:model(x?.llm??x?.model)})):null;
export function buildFeeInventory(agent,{region,regionSource,revision,llmList=null,llmReadStatus=null,now=new Date().toISOString()}={}){
 const c=object(agent.conversation_config),p=object(object(c.agent).prompt),turn=object(c.turn),soft=object(turn.soft_timeout_config),platform=object(agent.platform_settings),analysis=platform.analysis_items;
 if(p.custom_llm?.url!==STAGING_BRAIN)throw Error('Exact staging custom brain required');
 const migration=analysis===null?'legacy-fallback':analysis===undefined?'unknown':typeof analysis==='object'&&!Array.isArray(analysis)?'migrated':'invalid';
 const llms=Array.isArray(llmList?.llms)?llmList.llms:[];
 const selected=new Set([p.llm,typeof platform.analysis_llm==='string'?platform.analysis_llm:platform.analysis_llm?.llm].filter(Boolean));
 return {
  metadataOnly:true,dialed:false,generationRequests:0,configurationChanged:false,paidExecutionAllowed:false,inspectorRevision:revision??null,observedAt:now,
  region:{apiBase:region,configurationSource:regionSource,runtimeWorkerRegionMatchProven:false},
  agentConfigSha256:hash(agent),stagingBrain:true,
  native:{model:model(p.llm),customLlm:true,maxOutputTokens:finite(p.max_tokens),maxDurationSeconds:finite(object(c.conversation).max_duration_seconds),ttsModel:model(object(c.tts).model_id),cascadeTimeoutSeconds:finite(p.cascade_timeout_seconds),toolCount:count(p.tools),workflowPresent:agent.workflow!==undefined,workflowConfigSha256:agent.workflow===undefined?null:hash(agent.workflow)},
  generatedFillers:{useLlmGeneratedMessage:flag(soft.use_llm_generated_message),timeoutSeconds:finite(soft.timeout_seconds),maxPerGeneration:finite(soft.max_soft_timeouts_per_generation),promptOverridePresent:typeof soft.llm_generated_message_prompt_override==='string'&&soft.llm_generated_message_prompt_override.length>0,missingFlagMeansDisabled:false},
  analysis:{migration,analysisLlm:model(typeof platform.analysis_llm==='string'?platform.analysis_llm:platform.analysis_llm?.llm),analysisLlmConfigSha256:platform.analysis_llm===undefined?null:hash(platform.analysis_llm),evaluationItems:items(object(analysis).evaluation_criteria),dataCollectionItems:items(object(analysis).data_collection),legacyEvaluationCount:count(object(platform.evaluation).criteria),legacyDataCollectionCount:platform.data_collection&&typeof platform.data_collection==='object'?Object.keys(platform.data_collection).length:null,legacyConfigSha256:hash({evaluation:platform.evaluation,data_collection:platform.data_collection}),summaryLanguageConfigured:platform.summary_language!==undefined&&platform.summary_language!==null,automaticTranslation:flag(platform.auto_translate_transcript_to_app_language),automaticSummaryOrTitleFeeApplicability:'not-established-by-agent-metadata'},
  optionalFeatures:{topicDiscovery:feature(platform.topic_discovery),sentimentAnalysis:feature(platform.sentiment_analysis),guardrails:{present:platform.guardrails!==undefined,focus:feature(object(platform.guardrails).focus),promptInjection:feature(object(platform.guardrails).prompt_injection),content:feature(object(platform.guardrails).content),moderation:feature(object(platform.guardrails).moderation),custom:feature(object(platform.guardrails).custom)},safety:feature(platform.safety),alerting:feature(platform.alerting),workspaceOverrides:feature(platform.workspace_overrides)},
  llmMetadata:{readHttpStatus:llmReadStatus,models:llms.filter(x=>selected.has(x.llm)).map(x=>({model:model(x.llm),maxContextTokens:finite(x.max_context_limit),maxOutputTokens:finite(x.max_tokens_limit),regionalProcessingSurcharge:finite(x.regional_processing_surcharge),surchargeUnitAndApplicability:'not-established; informational only'})),monetaryRateProvided:false},
  pricing:{currency:'USD',verifiedAt:'2026-10-03',validBefore:'2026-10-04T00:00:00Z',references:[{url:'https://elevenlabs.io/pricing/agents',claims:['additional calls $0.08/minute','burst calls $0.16/minute','TTS/STT/knowledge bases/RAG included','LLM usage separate; optional LLM-enabled feature fees shown in platform UI','prices exclude taxes, levies and duties']},{url:'https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow',claims:['generated soft-timeout fillers use a separate lightweight LLM']}],conservativeNativeMinuteMicros:160000,optionalUpperMicros:null,optionalUpperBoundEstablished:false,remainingOptionalHeadroomFor600SecondsAndSixExistingModelBoundsMicros:242440,noIncludedMinuteDiscount:true},
  unresolved:['Account-applicable optional feature fees and units; model rates alone are not a generation-count/token ceiling.','Automatic summary/title/sentiment/topic/guardrail/workspace applicability not proven disabled by missing/default/empty schema fields.','Generated-filler auxiliary model, maximum input/output tokens and maximum total billable generations if enabled.','Analysis item and comparison-version model overrides and maximum total runs/tokens if configured.','Applicable regional surcharge, taxes and fees within the existing $5 ceiling.','Exact deployed Worker region/model/isolation/schema and remaining durable budget must be verified separately.'],
  uiEvidenceRequired:['Agent Advanced/Turn: actual generated-filler flag, auxiliary model, maximum generations and token ceilings.','Agent Analysis/Evaluation/Data Collection/Guardrails: enabled items, comparison versions, model overrides, summaries/title/sentiment/topics and account-applicable maximum charges.','Subscription/Billing: applicable rate units, regional processing surcharge and taxes/fees; no setting changes or purchases.'],
 };
}
async function getJson(url,key,fetcher){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
 try{
  const r=await fetcher(url,{method:'GET',headers:{'xi-api-key':key},redirect:'error',signal:controller.signal});
  if(!r.ok)return {status:r.status,body:null};
  const reader=r.body?.getReader();if(!reader)throw Error('Metadata response missing');
  let bytes=0;const chunks=[];
  for(;;){const item=await reader.read();if(item.done)break;bytes+=item.value.byteLength;if(bytes>512*1024){void reader.cancel().catch(()=>{});throw Error('Metadata response exceeds bound');}chunks.push(item.value);}
  return {status:r.status,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))};
 }catch{throw Error('Metadata read failed; no provider body or credentials retained');}finally{clearTimeout(timer);}
}
export async function inspectManagedAudioFees(env=process.env,fetcher=fetch){
 const key=env.ELEVENLABS_API_KEY,id=env.GROOMING_AGENT_ID,configured=String(env.ELEVENLABS_API_BASE??'').trim(),region=configured||'https://api.in.residency.elevenlabs.io';
 if(!key||!id)throw Error('Existing staging metadata credentials/agent missing');
 if(!REGIONS.includes(region))throw Error('Approved provider region required');
 const agent=await getJson(region+'/v1/convai/agents/'+encodeURIComponent(id),key,fetcher);
 if(!agent.body)throw Error('Agent metadata read refused: '+agent.status);
 // Validate the staging brain before any further read. Never follow redirects or fall back regions.
 buildFeeInventory(agent.body,{region});
 const llms=await getJson(region+'/v1/convai/llm/list',key,fetcher);
 const subscription=await getJson(region+'/v1/user/subscription',key,fetcher);
 const report=buildFeeInventory(agent.body,{region,regionSource:configured?'existing-staging-variable':'documented-existing-harness-default; runtime-match-unproven',revision:env.GITHUB_SHA,llmList:llms.body,llmReadStatus:llms.status});
 const account=object(subscription.body),invoice=object(account.next_invoice);
 report.accountBilling={readHttpStatus:subscription.status,tier:model(account.tier),currency:model(account.currency),status:model(account.status),creditLimitExtension:account.max_credit_limit_extension==='unlimited'?'unlimited':finite(account.max_credit_limit_extension),usageBasedBillingEnabled:flag(account.allowed_to_extend_character_limit),remainingIncludedCredits:finite(account.character_limit)!==null&&finite(account.character_count)!==null?account.character_limit-account.character_count:null,nextInvoiceSubtotalCents:finite(invoice.subtotal_cents),nextInvoiceTaxCents:finite(invoice.tax_cents),optionalFeeCeilingEstablished:false,taxCeilingEstablished:false,note:'Account observations only: invoice tax is not a future marginal tax ceiling, and credit limits do not establish USD optional-generation charges.'};
 return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const report=await inspectManagedAudioFees();
 await mkdir('artifacts/agent-deadlines',{recursive:true});
 await writeFile('artifacts/agent-deadlines/report.json',JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
}
