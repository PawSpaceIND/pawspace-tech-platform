import type {DegradationLog} from './degraded-reads';
/** Read-only passage retrieval. Visibility and effective-date checks stay with the database caller. */
type KnowledgeRow=Record<string,unknown>;
const STOP=new Set('a an the is are was were do does did i my me your you we our it this that for of on at to and or in with can could would should please what which how when there be have has'.split(' '));
const ALIASES:Record<string,string[]>={
 refund:['refund','refunds','reimbursement'],complaint:['complaint','complaints','grievance'],
 reschedule:['reschedule','rescheduling','rescheduled'],cancel:['cancel','cancellation','cancellations'],
 tax:['tax','taxes','gst'],payment:['payment','payments','pay','paying'],
 grooming:['grooming','groom','groomer'],training:['training','train','trainer'],
 socialisation:['socialisation','socialization'],price:['price','prices','pricing','cost','costs'],
 boarding:['boarding','board'],sitting:['sitting','sitter'],walking:['walking','walk','walker'],
 subscription:['subscription','subscriptions','pack','packs'],
};
export function knowledgeTokens(value:string):string[]{
 const words=value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu)||[];
 return [...new Set(words.filter(w=>w.length>=2&&!STOP.has(w)).map(w=>Object.entries(ALIASES).find(([,terms])=>terms.includes(w))?.[0]||w))];
}
type Passage={content:string;start:number;end:number;heading:string};
export function knowledgePassages(content:string):Passage[]{
 const result:Passage[]=[];let heading='';
 // Keep full paragraphs (including restrictions) rather than clipping the first N characters.
 for(const match of content.matchAll(/[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g)){
  const value=match[0].trim();if(!value)continue;
  if(/^#{1,6}\s/.test(value)&&!value.includes('\n')){heading=value.replace(/^#{1,6}\s+/,'');continue;}
  // Oversized paragraphs remain unavailable, not an authoritative, silently truncated policy.
  if(value.length>4800)continue;
  const start=match.index??0;result.push({content:value,start,end:start+match[0].length,heading});
 }
 return result;
}
function scoreTerms(tokens:string[],query:string[]){const set=new Set(tokens);return query.reduce((n,term)=>n+(set.has(term)?1:0),0);}
export function rankKnowledgePassages(rows:KnowledgeRow[],query:string,visibilityScopes:string[],limit=5,degradation?:DegradationLog){
 const queryTerms=knowledgeTokens(query),allowed=new Set(visibilityScopes.map(s=>s.toLowerCase()));
 if(!queryTerms.length)return [];
 const ranked=rows.flatMap(row=>{
  let scopes:string[]=[];
  try{
   const parsed:unknown=JSON.parse(String(row.visibility_scope_json||'[]'));
   if(!Array.isArray(parsed)||!parsed.every((scope:unknown)=>typeof scope==='string'))throw new Error('Invalid visibility shape');
   scopes=parsed.map((scope:string)=>scope.toLowerCase());
  }catch{
   // Do not expose the corrupt JSON, private content or source identity. Still fail closed.
   const error=new Error('Knowledge visibility metadata is invalid; the record was excluded');
   if(!degradation)throw error;
   return degradation.note('approved_knowledge_visibility',error,[]);
  }
  if(!scopes.includes('public')&&!scopes.some(s=>allowed.has(s)))return [];
  const title=String(row.title||''),text=String(row.content_text||'');
  const titleScore=scoreTerms(knowledgeTokens(title),queryTerms);
  const passages=knowledgePassages(text).map(p=>({...p,score:scoreTerms(knowledgeTokens(p.content),queryTerms)*2+scoreTerms(knowledgeTokens(p.heading),queryTerms)+titleScore*2})).sort((a,b)=>b.score-a.score||a.start-b.start);
  const best=passages[0];if(!best||best.score===0)return [];
  // A short source is one policy unit: retain its exceptions even when they score poorly.
  const section=best.heading?knowledgePassages(text).filter(p=>p.heading===best.heading):[];
  const sectionStart=section[0]?.start??best.start,sectionEnd=section.at(-1)?.end??best.end;
  const completeSource=text.length<=1600;
  const completeSection=Boolean(best.heading)&&sectionEnd-sectionStart<=4800;
  const start=completeSource?0:completeSection?sectionStart:best.start;
  const end=completeSource?text.length:completeSection?sectionEnd:best.end;
  const content=text.slice(start,end);
  // Return matching content with provenance, not an opening excerpt from elsewhere in the document.
  return [{id:String(row.id),sourceKey:String(row.source_key),version:Number(row.version),title,sourceType:String(row.source_type),visibilityScope:scopes,immutableHash:String(row.immutable_hash),score:best.score,content,passage:{start,end,heading:best.heading,completeParagraph:true,completeSource,completeSection},retrievalMethod:'unicode_synonym_passage_v1'}];
 });
 const bounded=Number.isFinite(limit)?Math.min(10,Math.max(1,Math.floor(limit))):5;
 return ranked.sort((a,b)=>b.score-a.score||b.version-a.version||a.sourceKey.localeCompare(b.sourceKey)).slice(0,bounded);
}
