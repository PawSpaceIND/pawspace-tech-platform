import {MAYA_KNOWLEDGE} from './maya-knowledge-base';
import {AI_KNOWLEDGE_OWNER_DECISIONS} from './ai-knowledge-owner-decisions';
import {ensureAiBusinessConfiguration,createAiBusinessDraft} from './ai-business-configuration';
/** Stages content only. Approval and activation continue through the ordinary audited lifecycle. */
export async function stageMayaKnowledgeDrafts(db:D1Database,actorEmail:string){
 await ensureAiBusinessConfiguration(db);const now=Date.now();let created=0,unchanged=0;const drafts:Array<{sourceKey:string;id:string}>=[];
 for(const entry of MAYA_KNOWLEDGE){
  const existing=await db.prepare("SELECT id FROM ai_knowledge_source_versions WHERE source_key=? AND title=? AND content_text=? AND source_type='policy' AND visibility_scope_json='[\"public\"]' AND (effective_to IS NULL OR effective_to>=?) AND status IN ('draft','review','approved','active') ORDER BY version DESC LIMIT 1").bind(entry.sourceKey,entry.title,entry.contentText,now).first<{id:string}>();
  if(existing){unchanged++;continue;}
  const result=await createAiBusinessDraft(db,{entityType:'knowledge',payload:{...entry,sourceType:'policy',visibilityScope:['public']},actorEmail});
  drafts.push({sourceKey:entry.sourceKey,id:result.id});created++;
 }
 return{created,unchanged,total:MAYA_KNOWLEDGE.length,drafts,activated:0,customerFacingChanged:false};
}
export async function aiKnowledgeCoverage(db:D1Database){
 await ensureAiBusinessConfiguration(db);const now=Date.now();
 const rows=(await db.prepare("SELECT id,source_key,title,version,status,content_text,visibility_scope_json,effective_from,effective_to FROM ai_knowledge_source_versions WHERE status IN ('draft','review','approved','active') ORDER BY version DESC").all<Record<string,unknown>>()).results;
 const current=(row:Record<string,unknown>)=>row.status==='active'&&(row.effective_from==null||Number(row.effective_from)<=now)&&(row.effective_to==null||Number(row.effective_to)>=now);
 const isPublic=(row:Record<string,unknown>)=>{try{const scopes=JSON.parse(String(row.visibility_scope_json));return Array.isArray(scopes)&&scopes.includes('public');}catch{return false;}};
 const topics=MAYA_KNOWLEDGE.map(entry=>{
  const candidates=rows.filter(r=>r.source_key===entry.sourceKey),active=candidates.find(r=>current(r)&&isPublic(r));
  const latest=candidates[0];
  return{sourceKey:entry.sourceKey,title:entry.title,status:active?'active':latest?String(latest.status):'missing',activeVersion:active?Number(active.version):null,matchesReviewedSource:Boolean(active&&active.content_text===entry.contentText&&active.title===entry.title)};
 });
 const active=topics.filter(t=>t.status==='active').length;
 return{scopeVersion:'maya-service-knowledge-2026-09-28',asOf:now,requiredTopics:topics.length,activeTopics:active,activeTopicPercent:Math.round(active/topics.length*100),sourceMatchedTopics:topics.filter(t=>t.matchesReviewedSource).length,topics,ownerDecisions:AI_KNOWLEDGE_OWNER_DECISIONS,ownerDecisionStatus:'review_required',liveToolCoverage:'not_certified',audioAcceptance:'not_certified',knowledgeComplete:false,customerReady:false,note:'Article presence is not proof of correct answers, commercial approval, tool coverage or successful audio. Owner decisions are not published by this read.'};
}
