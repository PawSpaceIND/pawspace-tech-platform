import{GROOMING_CLOSING_COUPON,GROOMING_CROSS_SELL_COUPON,rowToCampaign,seedUatCoupons}from"./coupon-governance";
import{groomingCatalogue}from"./grooming-governance";

type Row=Record<string,unknown>;

/**
 * The only offers PawSpace AI may give a customer, built on the server from the live coupon campaigns and
 * the catalogue's single-pet prices - the model never computes an offer price itself.
 *
 * GROOM200 is the closing discount the business set for a customer who hesitates on price (1349 / 1899 /
 * 2399 become 1149 / 1699 / 2199). GROOM400 is WATI's cross-sell, which reaches the AI only when the
 * customer's own enquiry already carries it. A paused, expired or deleted campaign simply drops out.
 */
export type ApprovedSalesOffer={name:string;code:string;usage:"closing"|"cross_sell";package_code:string;package_name:string;regular_price:number;discount_amount:number;offer_price:number;valid_until:string};

const USAGE:Record<string,ApprovedSalesOffer["usage"]>={[GROOMING_CLOSING_COUPON]:"closing",[GROOMING_CROSS_SELL_COUPON]:"cross_sell"};

export async function approvedSalesOffers(db:D1Database,asOf=Date.now()):Promise<ApprovedSalesOffer[]>{
 const read=async()=>(await db.prepare("SELECT * FROM coupon_campaigns WHERE code IN (?,?)").bind(GROOMING_CLOSING_COUPON,GROOMING_CROSS_SELL_COUPON).all<Row>()).results;
 let rows:Row[];
 // The campaigns are seeded on first use, as checkout seeds them; this runs on a chat turn (a write path).
 try{rows=await read();}catch(error){if(!/no such table/i.test(String((error as Error)?.message)))throw error;rows=[];}
 if(rows.length<2){await seedUatCoupons(db);rows=await read();}
 const offers:ApprovedSalesOffer[]=[];
 for(const campaign of rows.map(rowToCampaign)){
  if(campaign.status!=="active"||asOf<campaign.validFrom||asOf>campaign.validUntil||campaign.discountType!=="fixed"||!campaign.serviceCodes.includes("grooming"))continue;
  for(const code of campaign.packageCodes){
   const item=groomingCatalogue.find(row=>row.code===code&&row.active);if(!item)continue;
   const discount=Math.min(campaign.discountValue,campaign.maxDiscount??campaign.discountValue,item.singlePrice);
   if(item.singlePrice<campaign.minOrder)continue;
   const pet=item.eligiblePetTypes.includes("cat")&&!item.eligiblePetTypes.includes("dog")?"cat":"dog";
   offers.push({name:campaign.code,code:campaign.code,usage:USAGE[campaign.code]??"closing",package_code:item.code,package_name:`${item.name} (${pet}, 1 pet)`,regular_price:item.singlePrice,discount_amount:discount,offer_price:item.singlePrice-discount,valid_until:new Date(campaign.validUntil).toISOString().slice(0,10)});
  }
 }
 return offers;
}

/** How the AI may use approvedOffers - shared by web chat, WhatsApp and public chat prompts. */
export const APPROVED_OFFERS_DIRECTIVE=`Offers: approvedOffers lists the only coupon codes and discounts you may ever mention. ${GROOMING_CLOSING_COUPON} is the closing offer: use it at most once in a conversation, only after the customer hesitates on price for one of its listed packages, and state the code with that package's regular_price and offer_price exactly as listed (for example "With code ${GROOMING_CLOSING_COUPON}, Essential Bath comes to ₹1,149 instead of ₹1,349"). ${GROOMING_CROSS_SELL_COUPON} is the ₹400 grooming offer: mention it only when the customer's details already carry that code. The customer enters the code at checkout. Never invent any other code, percentage, amount off, free service or deadline; if approvedOffers is empty, offer no discount.`;

/* A code is written in capitals after "code", "coupon", "promo" or "voucher" ("use code SAVE50"). A PIN
 * code, an OTP or "the code below" is not a coupon: digits-only and lower-case words are left alone. */
const CODE_MENTION=/(?<!\bpin[\s-]?)\b(?:code|coupon|promo(?:\s*code)?|voucher)\s*[:\-]?\s*["'“‘]?([A-Za-z0-9]{4,20})\b/gi;
const looksLikeCode=(token:string)=>/[A-Z]/.test(token)&&token===token.toUpperCase();
const PERCENT_OFF=/\b\d{1,3}\s*%\s*(?:off|discount)/i;
const AMOUNT_OFF=/(?:₹|\brs\.?|\binr)?\s*(\d[\d,]{0,8})\s*(?:rupees\s*)?(?:off|discount)\b/gi;

/**
 * A reply mentions no offer the server did not approve: every code it names is an approved code, it
 * gives no percentage off, and every "N off" amount is an approved discount for a code the reply names.
 * Prices themselves are checked by pricesMatchCatalogue; this closes the discount claims that check
 * cannot see ("20% off", "use code SAVE50", "200 off").
 */
export function offerClaimsApproved(reply:string,offers:ApprovedSalesOffer[]){
 const value=reply.slice(0,8000),approved=new Set(offers.map(offer=>offer.code.toUpperCase()));
 const named=new Set<string>();
 for(const match of value.matchAll(CODE_MENTION)){if(!looksLikeCode(match[1]))continue;const code=match[1].toUpperCase();if(!approved.has(code))return false;named.add(code);}
 for(const offer of offers)if(new RegExp(`\\b${offer.code}\\b`,"i").test(value))named.add(offer.code.toUpperCase());
 if(PERCENT_OFF.test(value))return false;
 for(const match of value.matchAll(AMOUNT_OFF)){const amount=Math.round(Number(match[1].replace(/,/g,"")));if(!offers.some(offer=>named.has(offer.code.toUpperCase())&&offer.discount_amount===amount))return false;}
 return true;
}

/** Approved offer rows as catalogue grounding: an offer price counts only when the reply names its code. */
export function offerGroundingRows(offers:ApprovedSalesOffer[]):Row[]{return offers.map(offer=>({name:offer.code,package_code:offer.package_code,regular_price:offer.regular_price,discount_amount:offer.discount_amount,offer_price:offer.offer_price}));}
