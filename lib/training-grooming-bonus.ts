import{ensureCouponTables}from"./coupon-governance";
import{groomingCatalogue}from"./grooming-governance";
import{trainingBookingPaymentState}from"./training-payment-eligibility";

type Row=Record<string,unknown>;
export type TrainingGroomingBonus={status:"awaiting_full_payment"|"issued"|"used"|"expired";code:string|null;packageName:string;value:number;validUntil:number|null};

/**
 * The complimentary "Bath & Basic" grooming advertised on 8+ session Training plans. Founder decision
 * 26 Sep 2026: issue it once the programme is fully paid, as a one-time voucher valid for 90 days.
 *
 * The voucher is a governed coupon campaign bound to this customer (customer_ids_json), for the Bath &
 * Basic dog grooming package only, 100% off up to that package's price, one use in total. It is redeemed
 * through the ordinary grooming coupon field, so the grooming booking and its payment carry it like any
 * other coupon. Issuing is idempotent per Training booking (the campaign id is derived from it).
 */
export const TRAINING_GROOMING_BONUS_MIN_SESSIONS=8,TRAINING_GROOMING_BONUS_DAYS=90;
const BONUS_PACKAGE="dog-basic",DAY=86_400_000;
const bonusPackage=()=>groomingCatalogue.find(item=>item.code===BONUS_PACKAGE);

async function couponsLive(){try{const{env}=await import("cloudflare:workers");return String((env as unknown as Record<string,unknown>).PAWSPACE_COUPONS_LIVE_APPROVED||"").trim().toLowerCase()==="true";}catch{return false;}}

function view(row:Row,now:number):TrainingGroomingBonus{
 const pkg=bonusPackage(),validUntil=Number(row.valid_until),used=Number(row.used||0)>0;
 return{status:used?"used":validUntil<now?"expired":"issued",code:String(row.code),packageName:pkg?.name??"Bath & Basic",value:Number(row.max_discount),validUntil};
}

export async function ensureTrainingGroomingBonus(db:D1Database,input:{bookingId:string;now?:number;liveCoupons?:boolean}):Promise<TrainingGroomingBonus|null>{
 const now=input.now??Date.now(),bookingId=String(input.bookingId||"").trim();
 const booking=await db.prepare("SELECT id,customer_id,service_code,city_id,status FROM canonical_bookings WHERE id=?").bind(bookingId).first<Row>();
 if(!booking||String(booking.service_code)!=="dog_training"||["cancelled","refunded"].includes(String(booking.status)))return null;
 const plan=await db.prepare("SELECT q.sessions FROM training_booking_quote_links l JOIN training_commercial_quotes q ON q.id=l.quote_id WHERE l.booking_id=?").bind(bookingId).first<Row>().catch(()=>null);
 if(!plan||Number(plan.sessions)<TRAINING_GROOMING_BONUS_MIN_SESSIONS)return null;
 const pkg=bonusPackage();if(!pkg)return null;
 await ensureCouponTables(db);
 const id=`CPN-TRNBONUS-${bookingId}`;
 const read=()=>db.prepare("SELECT c.code,c.max_discount,c.valid_until,(SELECT COUNT(*) FROM coupon_redemptions r WHERE r.campaign_id=c.id AND r.status='consumed') used FROM coupon_campaigns c WHERE c.id=?").bind(id).first<Row>();
 const existing=await read();if(existing)return view(existing,now);
 if((await trainingBookingPaymentState(db,bookingId)).status!=="FULLY_PAID")return{status:"awaiting_full_payment",code:null,packageName:pkg.name,value:pkg.singlePrice,validUntil:null};
 const code=`BATH-${crypto.randomUUID().replace(/-/g,"").slice(0,8).toUpperCase()}`,live=input.liveCoupons??await couponsLive();
 await db.prepare("INSERT OR IGNORE INTO coupon_campaigns (id,code,name,status,test_only,service_codes_json,city_ids_json,channels_json,customer_kinds_json,package_scope,package_codes_json,cross_sell_from_services_json,first_order_only,min_order,max_order,subscription_eligible,full_payment_only,discount_type,discount_value,max_discount,per_customer_limit,total_limit,valid_from,valid_until,created_at,updated_at,customer_ids_json) VALUES (?,?,?,'active',?,'[\"grooming\"]',?,'[\"customer_app\",\"website\",\"assisted_staff\",\"whatsapp\"]','[\"new\",\"existing\",\"subscriber\"]','selected',?,'[]',0,0,NULL,0,0,'percent',100,?,1,1,?,?,?,?,?)")
  .bind(id,code,`Training bonus: ${pkg.name} for booking ${bookingId}`,live?0:1,JSON.stringify([String(booking.city_id||"blr")]),JSON.stringify([BONUS_PACKAGE]),pkg.singlePrice,now,now+TRAINING_GROOMING_BONUS_DAYS*DAY,now,now,JSON.stringify([String(booking.customer_id)])).run();
 const issued=await read();return issued?view(issued,now):null;
}
