import{customerFacts,rowToCampaign,seedUatCoupons,couponAmounts,type CouponChannel,type CouponQuoteInput}from"./coupon-governance";
import{couponEligibilityIssue}from"./coupon-eligibility-policy";
import{groomingCatalogue}from"./grooming-governance";

type Row=Record<string,unknown>;

/**
 * The only coupon offers PawSpace AI and the guided bot may give a customer, built on the server from the
 * live coupon campaigns and the catalogue's single-pet prices - the model never computes an offer price.
 *
 * The closing offer (seeded as GROOM200) is the discount the business set for a customer who hesitates on
 * price (1349 / 1899 / 2399 become 1149 / 1699 / 2199). The cross-sell (seeded as GROOM400) is WATI's
 * "₹400 off Pet Grooming". An offer is only listed while the customer can actually redeem it at checkout:
 * the campaign is active and in its window, serves this channel and the customer's city and kind, and
 * neither the customer's nor the campaign's redemption limit is used up. Staff pause, extend, re-limit or
 * even rename a code in Control > Coupons; the campaigns are found by their seeded ids.
 */
export type ApprovedSalesOffer={name:string;code:string;usage:"closing"|"cross_sell";package_code:string;package_name:string;regular_price:number;discount_amount:number;offer_price:number;valid_until:string;city_ids:string[];price_basis?:"booking_quote"|"catalogue_estimate";requires_checkout_validation?:boolean};

const CAMPAIGN_USAGE:Record<string,ApprovedSalesOffer["usage"]>={"sales-coupon-groom200":"closing","sales-coupon-groom400":"cross_sell"};
const CAMPAIGN_IDS=Object.keys(CAMPAIGN_USAGE);
/** The two seeded campaigns, bound as a fixed pair of placeholders. */
const SQL_IDS="?,?";

async function readCampaigns(db:D1Database){
 const read=async()=>(await db.prepare(`SELECT * FROM coupon_campaigns WHERE id IN (${SQL_IDS})`).bind(...CAMPAIGN_IDS).all<Row>()).results;
 // Seeded on first use, as checkout seeds them; this runs on a chat turn (a write path), and only until
 // both seeded rows exist - a renamed code keeps its id, so it never re-seeds on every turn.
 try{const rows=await read();if(rows.length>=CAMPAIGN_IDS.length)return rows;}catch(error){if(!/no such table/i.test(String((error as Error)?.message)))throw error;}
 await seedUatCoupons(db);return read();
}

async function redemptionCounts(db:D1Database,customerId:string){
 const result=await db.prepare(`SELECT campaign_id,COUNT(*) total,SUM(CASE WHEN customer_id=? THEN 1 ELSE 0 END) mine FROM coupon_redemptions WHERE status='consumed' AND campaign_id IN (${SQL_IDS}) GROUP BY campaign_id`).bind(customerId,...CAMPAIGN_IDS).all<Row>();
 if(!Array.isArray(result.results))throw new Error("AI coupon eligibility is temporarily unavailable");
 return new Map(result.results.map(row=>{
  const total=Number(row.total),mine=Number(row.mine);
  if(row.total==null||row.mine==null||!Number.isSafeInteger(total)||!Number.isSafeInteger(mine)||total<0||mine<0||mine>total)throw new Error("AI coupon eligibility is temporarily unavailable");
  return[String(row.campaign_id),{total,mine}];
 }));
}
export type SalesOfferContext=Omit<CouponQuoteInput,"code"|"customerId"|"bookingKey">;
export async function approvedSalesOffers(db:D1Database,input:{asOf?:number;customerId?:string|null;channel?:CouponChannel;context?:SalesOfferContext}={}):Promise<ApprovedSalesOffer[]>{
 const customerId=String(input.customerId||"").trim(),asOf=input.asOf??Date.now();
 // Anonymous visitors have no authoritative booking count or private entitlement. Ask for sign-in;
 // never invent a new-customer history or expose a privately restricted campaign in public chat.
 if(!customerId)return[];
 if(input.context&&input.channel&&input.context.channel!==input.channel)return[];
 const campaigns=(await readCampaigns(db)).map(rowToCampaign);
 const [counts,facts,liveApproved]=await Promise.all([
  redemptionCounts(db,customerId),
  customerFacts(db,customerId,{includeCustomer:true}),couponsLiveApproved(),
 ]);
 if(!facts.customerExists)return[];
 const cityId=String(input.context?.cityId||facts.cityId||"").trim();if(!cityId)return[];
 const channel=input.context?.channel??input.channel??"website";
 const offers:ApprovedSalesOffer[]=[];
 for(const campaign of campaigns){
  const codes=input.context?[input.context.packageCode]:campaign.packageCodes;
  for(const code of codes){
   const baseCode=code.replace(/__[2-4]_pets$/,"");
   const item=groomingCatalogue.find(row=>row.code===baseCode&&row.active);
   if(!item||(!input.context&&baseCode!==code))continue;
   const context:CouponQuoteInput={serviceCode:"grooming",cityId,channel,packageCode:code,orderValue:item.singlePrice,paymentMode:"full",isSubscription:false,...input.context,code:campaign.code,customerId};
   const used=counts.get(campaign.id)??{total:0,mine:0};
   if(couponEligibilityIssue(campaign,context,facts,{totalUsed:used.total,customerUsed:used.mine},{now:asOf,liveApproved}))continue;
   const amount=couponAmounts(context.orderValue,campaign);if(amount.discount<=0)continue;
   const pet=item.eligiblePetTypes.includes("cat")&&!item.eligiblePetTypes.includes("dog")?"cat":"dog";
   const petCount=code.match(/__([2-4])_pets$/)?.[1]||"1";
   offers.push({name:campaign.code,code:campaign.code,usage:CAMPAIGN_USAGE[campaign.id],package_code:code,package_name:`${item.name} (${pet}, ${petCount} pet${petCount==="1"?"":"s"})`,regular_price:context.orderValue,discount_amount:amount.discount,offer_price:amount.finalAmount,valid_until:new Date(campaign.validUntil).toISOString().slice(0,10),city_ids:campaign.cityIds,price_basis:input.context?"booking_quote":"catalogue_estimate",requires_checkout_validation:true});
  }
 }
 return offers;
}

/** The cross-sell the guided bot may promise right now, for this customer and channel, or null. */
export async function activeCrossSell(db:D1Database,input:{customerId?:string|null;channel:CouponChannel}):Promise<{code:string;cityIds:string[]}|null>{
 const offer=(await approvedSalesOffers(db,input).catch(()=>[] as ApprovedSalesOffer[])).find(item=>item.usage==="cross_sell");
 return offer?{code:offer.code,cityIds:offer.city_ids}:null;
}

/** How the AI may use approvedOffers - shared by web chat, WhatsApp and public chat prompts. */
export const APPROVED_OFFERS_DIRECTIVE=`Coupon codes: approvedOffers lists the only coupon codes you may ever mention, and only while they are listed. The offer with usage "closing" may be used at most once in a conversation, only after the customer hesitates on price for one of its listed packages: describe that package's regular_price and offer_price exactly as listed. In chat or WhatsApp, state the approved code. In voice, describe the savings without saying the code unless the caller explicitly asks for it; put an accepted code only in the governed booking proposal. Mention the offer with usage "cross_sell" only when the customer's details already carry its code. Offers marked catalogue_estimate are conditional catalogue estimates, not a promise of the final appointment total: date, add-ons, payment and pet-count changes require a fresh server quote. If the customer is not verified, ask them to sign in before discussing a coupon. In chat the customer enters the code at checkout; in voice an accepted code may be applied only through the governed booking quote and separately confirmed. Never invent, guess or alter a coupon code; if approvedOffers is empty, give no coupon. Any other discount may come only from an authorized sales lever stated elsewhere in these instructions.`;

/* Codes follow "code", "coupon", "promo", "voucher", or "coupon code" / "promo code" / "voucher code" /
 * "discount code" / "offer code" - matched as a whole, so the word "code" is never taken for the code. */
const CODE_MENTION=/(?<!\bpin[\s-]?)\b(?:(?:coupon|promo|voucher|discount|offer)\s*code|code|coupon|promo|voucher)\s*[:\-]?\s*["'“‘]?([A-Za-z0-9]{4,20})\b/gi;
/** A mentioned word is a code when it mixes letters and digits, or is written in capitals ("WELCOME"). A PIN, an OTP or "the code below" is not. */
const looksLikeCode=(token:string)=>/[a-z]/i.test(token)&&(/\d/.test(token)||token===token.toUpperCase());
/** Code-shaped words anywhere ("Apply FLAT500 at checkout"): letters then at least two digits. A reference
 * that follows a hyphen, underscore, slash or # (CASE-AB12, order_…) is an identifier, not a coupon. */
const CODE_SHAPED=/(?<![-_/#])\b([A-Za-z]{2,12}\d{2,6})\b/g;
const NOT_A_CODE=/^(?:rs|inr|upi)\d/i;
const APPROVED_AMOUNT_OFF=/(?:₹|\brs\.?|\binr)\s*(\d[\d,]{0,8})\s*off\b/gi;

/** Sentences, so a "₹N off" is tied to a code named in the same sentence, not anywhere in the reply. */
const sentences=(value:string)=>value.split(/(?<=[.!?])\s+|\n+/);
function namedCodes(reply:string,offers:ApprovedSalesOffer[]){const named=new Set<string>();for(const offer of offers)if(new RegExp(`\\b${offer.code}\\b`,"i").test(reply))named.add(offer.code.toUpperCase());return named;}

/**
 * A reply names no coupon code the server did not approve for this customer, and a rupee "off" amount
 * next to an approved code is that code's own discount. Other discount wording (a multi-pet saving, a sales
 * lever the quota directive authorizes) is left to the prompt and the price check, exactly as before.
 */
export function offerClaimsApproved(reply:string,offers:ApprovedSalesOffer[]){
 const value=reply.slice(0,8000),approved=new Set(offers.map(offer=>offer.code.toUpperCase()));
 for(const match of value.matchAll(CODE_MENTION))if(looksLikeCode(match[1])&&!approved.has(match[1].toUpperCase()))return false;
 for(const match of value.matchAll(CODE_SHAPED))if(!NOT_A_CODE.test(match[1])&&!approved.has(match[1].toUpperCase()))return false;
 for(const sentence of sentences(value)){
  const named=namedCodes(sentence,offers);
  if(named.size)for(const match of sentence.matchAll(APPROVED_AMOUNT_OFF)){const amount=Math.round(Number(match[1].replace(/,/g,"")));if(!offers.some(offer=>named.has(offer.code.toUpperCase())&&offer.discount_amount===amount))return false;}
 }
 return true;
}

/** "₹400 off" next to its own approved code is a discount, not a price: it is removed before prices are checked. */
export function withoutApprovedDiscounts(reply:string,offers:ApprovedSalesOffer[]){
 return sentences(reply.slice(0,8000)).map(sentence=>{const named=namedCodes(sentence,offers);if(!named.size)return sentence;
  return sentence.replace(APPROVED_AMOUNT_OFF,(whole,amount:string)=>offers.some(offer=>named.has(offer.code.toUpperCase())&&offer.discount_amount===Math.round(Number(amount.replace(/,/g,""))))?"":whole);}).join("\n");
}

/** Approved offers as price grounding: only the regular and offer prices, and only when the reply names the code. */
export function offerGroundingRows(offers:ApprovedSalesOffer[]):Row[]{return offers.map(offer=>({name:offer.code,package_code:offer.package_code,regular_price:offer.regular_price,offer_price:offer.offer_price}));}

/** Whether a campaign switched to live money may be quoted in this environment (Control > Coupons). */
export async function couponsLiveApproved(){try{const{env}=await import("cloudflare:workers");return String((env as unknown as Row).PAWSPACE_COUPONS_LIVE_APPROVED||"").trim().toLowerCase()==="true";}catch{return false;}}
