import {isSalesInformationQuestion} from "./ai-sales-information";
/** Conservative information-only policy enquiries. This does not authorise any tool or action. */
export type PolicyEnquiryTopic='refund_process'|'complaint_process'|'booking_change_process'|'payment_process';
export const POLICY_INFORMATION_SIGNAL='policy_information_only';
const ACTIVE_RISK=[
 /\b(?:human|person|staff|agent|representative|manager|coordinator)\b/i,
 /\b(?:very unhappy|serious issue|service failure|not happy|no[- ]?show|missed (?:my|our)|damaged|hurt|unsafe|mistreat(?:ed|ment)?)\b/i,
 /\b(?:charged|debited|billed) (?:me )?(?:twice|again|incorrectly)|\b(?:double|duplicate|wrong) (?:charge|debit)|\bpayment dispute/i,
 /\b(?:my|our) (?:refund|complaint|dispute)|\b(?:i|we) (?:want|need|demand|request) (?:a |my |our )?(?:refund|money back)/i,
 /\b(?:i|we) (?:was|were|have been|got) (?:charged|debited)|\byou (?:have )?charged/i,
 /\b(?:bleeding|injured|injury|seizure|collapsed|poisoned|not breathing|emergency|lost pet|missing dog|bitten)\b/i,
 /\b(?:connect|transfer|hand|route|escalate|speak|talk).{0,45}\b(?:human|person|staff|agent|coordinator|manager)|\bcall me\b/i,
 /\b(?:ignore|override|bypass).{0,40}\b(?:rules|instructions|safety|checks|policy)|\b(?:system prompt|developer message)\b/i,
];
// Date/currentness words alone do not turn a complete general-policy question into a dispute.
// Only a whole, standalone FAQ qualifies; mixed requests and reports keep the temporal-risk gate.
const TEMPORAL_RISK=/\b(?:yesterday|today|right now|currently|already|still|never|hasn't|didn't|did not|has not|last visit|last booking)\b/i;
const CURRENT_POLICY_QUESTION=/^(?:what(?:'s| is| are)|(?:please )?explain|(?:can|could) you (?:please )?explain)\s+(?:(?:your|the|pawspace's)\s+)?(?:current\s+)?(?:refund|cancellation|rescheduling|complaint)\s+(?:policy|policies|process|procedure|rules|terms)(?:\s+(?:currently|today|right now|at the moment|as of today))?[?!.]*$/i;
export function policyEnquiryTopic(input:string):PolicyEnquiryTopic|null{
 if(!input||input.length>1200)return null;
 const text=input.normalize('NFKC').replace(/[’‘]/g,"'").replace(/\s+/g,' ').trim();
 if(ACTIVE_RISK.some(p=>p.test(text)))return null;
 if(TEMPORAL_RISK.test(text)&&!CURRENT_POLICY_QUESTION.test(text))return null;
 // Whole, standalone questions about terms are not instructions to take money.
 // Anchoring excludes compound execution, disputes and follow-up confirmation.
 if(/^(?:what payment (?:options|methods) (?:are available|do you accept)|can i (?:make a |pay )?(?:50%|fifty percent|split)(?: payment)?|can you give me a quote with split payment)[?!.]*$/i.test(text))return 'payment_process';
 // A bounded process FAQ is not a payment instruction. Keep mixed commands and disputes out.
 if(isSalesInformationQuestion(text)&&! /\b(?:send|take|capture|charge|debit|pay|transfer|approve|execute|initiate|complete|then|ignore|bypass)\b/i.test(text)&&/\b(?:how (?:is|are) payments? handled|how (?:does|do) payments? work|when (?:is|are) payments? due|what payment methods (?:are available|do you accept))[?!.]*$/i.test(text))return 'payment_process';
 const question=text.replace(/^(?:(?:this is an (?:enquiry|inquiry) only|do not (?:issue a refund|change any booking|cancel any booking|book anything))\.\s*)+/i,'');
 // Only a process question, not a request to initiate, approve, cancel, reschedule or transfer.
 if(!/^(?:please )?(?:explain\b|how\b|what\b|if\b|where\b|can you explain\b|could you explain\b)/i.test(question))return null;
 if(/\b(?:issue|process|approve|give|send) (?:me |us )?(?:a |my |the )?refund\b|\b(?:cancel|reschedule|change) my\b|\braise (?:a |my )?complaint (?:for me|now)\b/i.test(question))return null;
 if(!/\b(?:process|policy|policies|review|reviewed|work|works|happen|happens|procedure|steps|charges|raise a complaint|follow it up)\b/i.test(question))return null;
 // Additional commands joined after a policy question do not inherit its read-only exemption.
 if(/\b(?:and then|also|but|actually|by the way)\b|[;{}<>]/i.test(question))return null;
 if(/\b(?:refund|refunds|money back)\b/i.test(question))return 'refund_process';
 if(/\b(?:complaint|complaints|grievance)\b/i.test(question))return 'complaint_process';
 if(/\b(?:reschedule|rescheduling|cancel|cancellation|cancellations)\b/i.test(question))return 'booking_change_process';
 return null;
}
export const POLICY_INFORMATION_DIRECTIVE='This turn is an information-only policy enquiry, not permission to initiate a refund, complaint, cancellation, booking, payment or handoff. Explain the relevant approved process first. Use no action envelope or mutation tools. Do not promise a fee, refund amount, deadline, entitlement or completed action without the applicable approved source. A general question must not be described as an existing dispute or a completed team transfer. Do not append a sales pitch. If one detail is unavailable, identify that detail while explaining the supported process.';
