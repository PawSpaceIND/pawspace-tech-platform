const rows=[
 ['en','English',"Hi, this is Maya from PawSpace. How can I help with your pet today?"],
 ['hi','Hindi',"नमस्ते, मैं PawSpace से माया बोल रही हूँ। आज मैं आपके पालतू के लिए कैसे मदद कर सकती हूँ?"],
 ['ta','Tamil',"வணக்கம், நான் PawSpace-லிருந்து மாயா பேசுகிறேன். இன்று உங்கள் செல்லப்பிராணிக்காக நான் எப்படி உதவலாம்?"],
 ['ml','Malayalam',"നമസ്കാരം, ഞാൻ PawSpace-ൽ നിന്നുള്ള മായയാണ്. ഇന്ന് നിങ്ങളുടെ വളർത്തുമൃഗത്തിനായി എങ്ങനെ സഹായിക്കാം?"],
 ['te','Telugu',"నమస్కారం, నేను PawSpace నుంచి మాయ మాట్లాడుతున్నాను. ఈ రోజు మీ పెంపుడు జంతువు కోసం నేను ఎలా సహాయం చేయగలను?"],
 ['pa','Punjabi',"ਸਤ ਸ੍ਰੀ ਅਕਾਲ, ਮੈਂ PawSpace ਤੋਂ ਮਾਇਆ ਬੋਲ ਰਹੀ ਹਾਂ। ਅੱਜ ਮੈਂ ਤੁਹਾਡੇ ਪਾਲਤੂ ਜਾਨਵਰ ਲਈ ਕਿਵੇਂ ਮਦਦ ਕਰ ਸਕਦੀ ਹਾਂ?"],
 ['mr','Marathi',"नमस्कार, मी PawSpace मधून माया बोलते आहे. आज मी तुमच्या पाळीव प्राण्यासाठी कशी मदत करू शकते?"],
 ['bn','Bengali',"নমস্কার, আমি PawSpace থেকে মায়া বলছি। আজ আপনার পোষ্যর জন্য আমি কীভাবে সাহায্য করতে পারি?"],
 ['kn','Kannada',"ನಮಸ್ಕಾರ, ನಾನು PawSpace‌ನಿಂದ ಮಾಯಾ ಮಾತನಾಡುತ್ತಿದ್ದೇನೆ. ಇಂದು ನಿಮ್ಮ ಸಾಕುಪ್ರಾಣಿಗಾಗಿ ನಾನು ಹೇಗೆ ಸಹಾಯ ಮಾಡಬಹುದು?"],
];
export const PREMIUM_LANGUAGE_CODES=Object.freeze(rows.map(([code])=>code));
export const PREMIUM_LANGUAGES=Object.freeze(Object.fromEntries(rows.map(([code,name,firstMessage])=>[code,Object.freeze({code,name,firstMessage})])));
export function premiumLanguagePresets(voiceIds={}){
 const presets={};
 for(const [code,,firstMessage] of rows){
  if(code==='en')continue;
  const voiceId=String(voiceIds?.[code]||'').trim();
  presets[code]={overrides:{agent:{first_message:firstMessage},...(voiceId?{tts:{voice_id:voiceId}}:{})}};
 }
 return presets;
}
export function languageDetectionTool(existing={}){
 const source=existing&&typeof existing==='object'&&!Array.isArray(existing)?existing:{};
 const params=source.params&&typeof source.params==='object'&&!Array.isArray(source.params)?source.params:{};
 return{
  ...source,
  type:'system',
  name:'language_detection',
  description:"Switch Maya to the caller's clearly preferred supported language when the caller speaks a sustained phrase in that language or explicitly asks to switch. Supported: English, Hindi, Tamil, Malayalam, Telugu, Punjabi, Marathi, Bengali and Kannada. Do not switch because of one borrowed English word, a pet name, a locality, a package name, an address, or normal Indian code-mixing. In mixed-language speech, follow the dominant language unless the caller explicitly requests another language. A language switch must preserve all already confirmed booking details.",
  params:{...params,system_tool_type:'language_detection'}
 };
}
export function premiumLanguagePrompt(existing=''){
 const marker='[PawSpace premium multilingual v1]';
 let base=String(existing||'').trim();
 const index=base.indexOf(marker);if(index>=0)base=base.slice(0,index).trim();
 const rules=marker+"\nReply in the caller's active language. Maya supports English, Hindi, Tamil, Malayalam, Telugu, Punjabi, Marathi, Bengali and Kannada. If the caller explicitly asks to change language, comply when that language is supported. Indian callers often code-mix: follow the dominant language naturally and never switch merely because of an English service name, pet name, locality, address, number or package name. Preserve every already confirmed booking fact across a language switch; language changes presentation, never customer identity, pet selection, date, time, address, PIN, package, quoted amount or action authority. Translate customer-facing explanations naturally, but never translate or alter internal IDs, tool names, package codes, payment states or other canonical machine values. Keep PawSpace as the brand name. Preserve familiar service names when translating them would sound unnatural, and explain them conversationally if the caller asks. Never invent a regional policy or price because of the caller's language.";
 return [base,rules].filter(Boolean).join('\n\n');
}
export const PREMIUM_CALL_TARGETS=Object.freeze({
 replyStartP50Ms:1200,
 replyStartP95Ms:2000,
 toolAcknowledgementMs:1000,
 maxSilentGapMs:900,
 minNaturalTurns:10,
 maxRepeatedKnownFacts:0,
 maxCallSeconds:600,
});
export function evaluatePremiumCallQuality(metrics={}){
 const t=PREMIUM_CALL_TARGETS;
 const measured=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
 const atMost=(value,max)=>measured(value)&&value<=max;
 const checks={
  replyP50:atMost(metrics.replyStartP50Ms,t.replyStartP50Ms),
  replyP95:atMost(metrics.replyStartP95Ms,t.replyStartP95Ms),
  toolAck:atMost(metrics.toolAcknowledgementMs,t.toolAcknowledgementMs),
  silentGap:atMost(metrics.maxSilentGapMs,t.maxSilentGapMs),
  naturalTurns:measured(metrics.naturalTurns)&&Number.isInteger(metrics.naturalTurns)&&metrics.naturalTurns>=t.minNaturalTurns,
  repeatedKnownFacts:atMost(metrics.repeatedKnownFacts,t.maxRepeatedKnownFacts),
  bookingCompleted:metrics.bookingCompleted===true,
  gracefulEnding:metrics.gracefulEnding===true,
  humanTransferReady:metrics.humanTransferReady===true,
 };
 return{pass:Object.values(checks).every(Boolean),checks,targets:t,metrics};
}
function validLanguagePreset(value){
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const overrides=value.overrides;
 if(!overrides||typeof overrides!=='object'||Array.isArray(overrides))return false;
 const agent=overrides.agent;
 return Boolean(agent&&typeof agent==='object'&&!Array.isArray(agent)&&String(agent.first_message||'').trim());
}
export function premiumLanguageReadiness(config={}){
 const presets=config.language_presets&&typeof config.language_presets==='object'&&!Array.isArray(config.language_presets)?config.language_presets:{};
 const prompt=config.agent?.prompt&&typeof config.agent.prompt==='object'&&!Array.isArray(config.agent.prompt)?config.agent.prompt:{};
 const tool=prompt.built_in_tools?.language_detection;
 const configured=PREMIUM_LANGUAGE_CODES.filter(code=>code==='en'||validLanguagePreset(presets[code]));
 const languageVoices=PREMIUM_LANGUAGE_CODES.filter(code=>code==='en'||(validLanguagePreset(presets[code])&&String(presets[code]?.overrides?.tts?.voice_id||'').trim()));
 return{
  supportedCodes:PREMIUM_LANGUAGE_CODES,
  configuredCodes:configured,
  languageDetection:Boolean(tool&&tool.params?.system_tool_type==='language_detection'),
  allLanguagesConfigured:configured.length===PREMIUM_LANGUAGE_CODES.length,
  localizedVoiceCodes:languageVoices,
  localizedVoicesComplete:languageVoices.length===PREMIUM_LANGUAGE_CODES.length,
  configurationComplete:Boolean(tool?.params?.system_tool_type==='language_detection'&&configured.length===PREMIUM_LANGUAGE_CODES.length&&languageVoices.length===PREMIUM_LANGUAGE_CODES.length),
  premiumCertified:false,
  certificationReason:'Language configuration is not attended audio or completed-sales evidence'
 };
}
