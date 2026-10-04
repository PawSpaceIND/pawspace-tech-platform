/** Bounded offline acceptance checks. Passing does not establish naturalness or live-model accuracy. */
export function evaluateConsultationTurn(input:{reply:string;actions?:unknown[];informationOnly?:boolean;expectedFacts?:string[];forbiddenFacts?:string[];handoffReceipt?:boolean;maximumQuestions?:number}){
 const failures:string[]=[];
 for(const fact of input.expectedFacts??[])if(!input.reply.toLowerCase().includes(fact.toLowerCase()))failures.push(`missing_context:${fact}`);
 for(const fact of input.forbiddenFacts??[])if(input.reply.toLowerCase().includes(fact.toLowerCase()))failures.push(`stale_context:${fact}`);
 if((input.reply.match(/\?/g)??[]).length>(input.maximumQuestions??2))failures.push('too_many_questions');
 if(input.informationOnly&&input.actions?.length)failures.push('information_only_actions');
 if(/\b(?:guaranteed results|guaranteed cure|usually upgrade|only slot left|spend more.*best for.*pet|best for.*pet.*spend more)\b/i.test(input.reply))failures.push('unsupported_sales_claim');
 if(/\b(?:connected you|transferred you|a teammate is on the line)\b/i.test(input.reply)&&!input.handoffReceipt)failures.push('unreceipted_live_handoff');
 return{passed:failures.length===0,failures};
}
