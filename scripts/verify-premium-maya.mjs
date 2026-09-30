import {PREMIUM_CALL_TARGETS,premiumLanguageReadiness} from '../lib/elevenlabs-language-profile.mjs';

const apiBase=String(process.env.ELEVENLABS_API_BASE||'https://api.elevenlabs.io').replace(/\/$/,'');
const key=String(process.env.ELEVENLABS_API_KEY||'').trim();
const agentId=String(process.env.GROOMING_AGENT_ID||'').trim();
if(!key||!agentId)throw new Error('Premium Maya readiness prerequisites missing');

const response=await fetch(apiBase+'/v1/convai/agents/'+encodeURIComponent(agentId),{headers:{'xi-api-key':key},signal:AbortSignal.timeout(30000)});
const agent=await response.json().catch(()=>({}));
if(!response.ok)throw new Error('Premium Maya agent read failed '+response.status);
const cc=agent?.conversation_config||{},tts=cc?.tts||{},turn=cc?.turn||{},conversation=cc?.conversation||{},readiness=premiumLanguageReadiness(cc);
const result={
 languageDetection:readiness.languageDetection,
 configuredCodes:readiness.configuredCodes,
 localizedVoiceCodes:readiness.localizedVoiceCodes,
 allLanguagesConfigured:readiness.allLanguagesConfigured,
 localizedVoicesComplete:readiness.localizedVoicesComplete,
 configurationComplete:readiness.configurationComplete,
 premiumCertified:readiness.premiumCertified,
 certificationReason:readiness.certificationReason,
 ttsModel:tts.model_id||tts.model||null,
 expressiveMode:tts.expressive_mode===true,
 stability:tts.stability??null,
 similarityBoost:tts.similarity_boost??null,
 speed:tts.speed??null,
 turnTimeout:turn.turn_timeout??null,
 silenceEndCallTimeout:turn.silence_end_call_timeout??null,
 maxDurationSeconds:conversation.max_duration_seconds??null,
 qualityTargets:PREMIUM_CALL_TARGETS,
};
console.log('PREMIUM_MAYA_READINESS='+JSON.stringify(result));
if(!result.allLanguagesConfigured)throw new Error('Premium Maya does not have every required language configured');
if(!result.languageDetection)throw new Error('Premium Maya language detection is not enabled');
if(result.ttsModel!=='eleven_v3_conversational')throw new Error('Premium Maya is not on the approved expressive conversational model');
if(result.expressiveMode!==true)throw new Error('Premium Maya expressive mode is not enabled');
const maxDurationSeconds=Number(result.maxDurationSeconds);
if(!Number.isFinite(maxDurationSeconds)||maxDurationSeconds<600)throw new Error('Premium Maya maximum call duration is missing, invalid, or below ten minutes');
const turnTimeout=Number(result.turnTimeout);
if(!Number.isFinite(turnTimeout)||turnTimeout<=0||turnTimeout>10)throw new Error('Premium Maya turn timeout is missing, invalid, non-positive, or too slow');
const silenceEndCallTimeout=Number(result.silenceEndCallTimeout);
if(!Number.isFinite(silenceEndCallTimeout)||silenceEndCallTimeout<90)throw new Error('Premium Maya silence tolerance is missing, invalid, or too short');
if(!result.localizedVoicesComplete)console.log('PREMIUM_MAYA_LOCALIZED_VOICES_PENDING=yes');
