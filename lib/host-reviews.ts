type Db=D1Database;
type Row=Record<string,unknown>;
const rows=<T=Row>(result:{results?:unknown[]})=>(result.results||[]) as T[];

export type HostReview={id:string;hostProviderId:string;customerId:string;bookingId:string;serviceCode:string;rating:1|2|3|4|5;title:string;body:string;createdAt:number;replies:Array<{replyBody:string;createdAt:number}>};

export type HostReviewInput={hostProviderId:string;customerId:string;bookingId:string;rating:number;title:string;body:string};

export type HostReviewStats={avgRating:number;totalReviews:number;ratingHistogram:Record<1|2|3|4|5,number>};

const RATING_TITLE_RE=/^.{5,100}$/;
const RATING_BODY_RE=/^.{10,500}$/;

export async function ensureHostReviewsTables(db:Db){
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS host_reviews (id TEXT PRIMARY KEY, host_provider_id TEXT NOT NULL, customer_id TEXT NOT NULL, booking_id TEXT NOT NULL UNIQUE, service_code TEXT NOT NULL, rating INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS host_reviews_provider_idx ON host_reviews(host_provider_id, created_at DESC)"),
    db.prepare("CREATE INDEX IF NOT EXISTS host_reviews_booking_idx ON host_reviews(booking_id)"),
    db.prepare("CREATE TABLE IF NOT EXISTS host_review_replies (id TEXT PRIMARY KEY, review_id TEXT NOT NULL, reply_body TEXT NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(review_id) REFERENCES host_reviews(id))"),
    db.prepare("CREATE INDEX IF NOT EXISTS host_review_replies_review_idx ON host_review_replies(review_id, created_at)"),
  ]);
}

async function safeAll(db:Db,sql:string,bindings:unknown[]=[]){
  try{
    let statement=db.prepare(sql);
    if(bindings.length)statement=statement.bind(...bindings);
    return rows(await statement.all<Row>());
  }catch{
    return[] as Row[];
  }
}

export async function submitHostReview(db:Db,input:HostReviewInput):Promise<HostReview>{
  await ensureHostReviewsTables(db);
  const{hostProviderId,customerId,bookingId,rating,title,body}=input;

  // Validate inputs
  if(!hostProviderId||!customerId||!bookingId)throw new Error("hostProviderId, customerId, and bookingId are required");
  if(!Number.isInteger(rating)||rating<1||rating>5)throw new Error("Rating must be an integer between 1 and 5");
  if(!RATING_TITLE_RE.test(title))throw new Error("Title must be 5-100 characters");
  if(!RATING_BODY_RE.test(body))throw new Error("Body must be 10-500 characters");

  // Verify the booking exists, belongs to customer, and is for this host
  const booking=await db.prepare("SELECT id,customer_id,provider_id,status,service_code FROM canonical_bookings WHERE id=?").bind(bookingId).first<Row>();
  if(!booking)throw new Error("Booking not found");
  if(String(booking.customer_id)!==customerId)throw new Error("Booking does not belong to this customer");
  if(String(booking.provider_id)!==hostProviderId)throw new Error("Booking was not completed by this host");
  if(String(booking.status)!=="completed")throw new Error("Only completed bookings can be reviewed");

  // Check for duplicate review (one per booking)
  const existing=await db.prepare("SELECT id FROM host_reviews WHERE booking_id=?").bind(bookingId).first<Row>();
  if(existing)throw new Error("Review already submitted for this booking");

  const now=Date.now();
  const id=crypto.randomUUID();
  await db.prepare("INSERT INTO host_reviews (id,host_provider_id,customer_id,booking_id,service_code,rating,title,body,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(id,hostProviderId,customerId,bookingId,String(booking.service_code),rating,title,body,now).run();

  return{
    id,
    hostProviderId,
    customerId,
    bookingId,
    serviceCode:String(booking.service_code),
    rating:rating as 1|2|3|4|5,
    title,
    body,
    createdAt:now,
    replies:[],
  };
}

export async function listHostReviews(db:Db,hostProviderId:string,options:{limit?:number;offset?:number}={}):Promise<{reviews:HostReview[];stats:HostReviewStats}>{
  await ensureHostReviewsTables(db);
  const limit=Math.min(options.limit||10,100);
  const offset=options.offset||0;

  // Fetch reviews
  const reviewRows=await safeAll(db,"SELECT * FROM host_reviews WHERE host_provider_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?",[hostProviderId,limit,offset]);

  // Fetch stats for all reviews
  const statsRow=await db.prepare("SELECT AVG(rating) avg_rating,COUNT(*) total_reviews FROM host_reviews WHERE host_provider_id=?").bind(hostProviderId).first<Row>();
  const ratingCounts=await safeAll(db,"SELECT rating,COUNT(*) as count FROM host_reviews WHERE host_provider_id=? GROUP BY rating",[hostProviderId]);

  const avgRating=Number(statsRow?.avg_rating||0);
  const totalReviews=Number(statsRow?.total_reviews||0);

  const histogram:Record<1|2|3|4|5,number>={1:0,2:0,3:0,4:0,5:0};
  for(const row of ratingCounts){
    const rating=Number(row.rating) as 1|2|3|4|5;
    if(rating in histogram)histogram[rating]=Number(row.count||0);
  }

  // Fetch replies for each review
  const reviews:HostReview[]=[];
  for(const review of reviewRows){
    const replyRows=await safeAll(db,"SELECT reply_body,created_at FROM host_review_replies WHERE review_id=? ORDER BY created_at ASC",[review.id]);
    reviews.push({
      id:String(review.id),
      hostProviderId:String(review.host_provider_id),
      customerId:String(review.customer_id),
      bookingId:String(review.booking_id),
      serviceCode:String(review.service_code),
      rating:Number(review.rating) as 1|2|3|4|5,
      title:String(review.title),
      body:String(review.body),
      createdAt:Number(review.created_at),
      replies:replyRows.map(r=>({replyBody:String(r.reply_body),createdAt:Number(r.created_at)})),
    });
  }

  return{
    reviews,
    stats:{avgRating:Math.round(avgRating*100)/100,totalReviews,ratingHistogram:histogram},
  };
}

export async function seedHostReviews(db:Db){
  await ensureHostReviewsTables(db);
  const now=Date.now();

  const demoHosts=["host_maya_rohan","host_sana","host_arjun_tara","host_priya_dev","sit_sana","sit_neha","sit_asha"];
  const demoCustomers=["uat_seed_customer_1","uat_seed_customer_2","uat_seed_customer_3","uat_seed_customer_4","uat_seed_customer_5","uat_seed_customer_6"];
  const reviews=[
    {rating:5,title:"Excellent care and communication",body:"Maya was incredibly attentive to our dog's needs. She provided daily updates with photos and videos. Our pet came back happy and well-rested."},
    {rating:5,title:"Professional and trustworthy",body:"Booked a 5-day stay with Sana for our boarding. She has a beautiful home setup for dogs. Highly recommend for pet parents who want peace of mind."},
    {rating:4,title:"Great stay, minor timing issue",body:"Arjun was wonderful with our sitting bookings. The only small issue was a slight delay in pickup on the last day, but overall very satisfied."},
    {rating:5,title:"Our dog loves her!",body:"Priya has hosted our dog three times now. Our pet actually shows excitement when we mention visiting her place. She clearly loves animals."},
    {rating:4,title:"Professional sitting service",body:"Sana looks after our cat while we travel. She sends updates and follows our instructions precisely. Reliable and caring."},
    {rating:5,title:"Trustworthy and caring",body:"Neha watched our two dogs for a week. They were treated like family. She has experience with anxious pets and made them feel comfortable."},
    {rating:4,title:"Good experience overall",body:"Asha hosted our boarding stay. The accommodation was clean and comfortable. She was responsive to questions. Would book again."},
    {rating:5,title:"The best in the neighborhood",body:"Maya has been our go-to host for over a year. Consistently excellent service, great communication, and our pet is always happy."},
    {rating:3,title:"Decent service",body:"Priya did a good job minding our pet. Nothing exceptional but reliable. Would consider booking again."},
  ];

  const statements=[];
  for(let i=0;i<reviews.length;i++){
    const review=reviews[i];
    const hostId=demoHosts[i%demoHosts.length];
    const customerId=demoCustomers[i%demoCustomers.length];
    const bookingId=`booking_seed_${i+1}`;
    const reviewId=crypto.randomUUID();

    const existing=await db.prepare("SELECT id FROM host_reviews WHERE booking_id=?").bind(bookingId).first<Row>();
    if(!existing){
      statements.push(
        db.prepare("INSERT INTO host_reviews (id,host_provider_id,customer_id,booking_id,service_code,rating,title,body,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
          .bind(reviewId,hostId,customerId,bookingId,i%2===0?"boarding":"pet_sitting",review.rating,review.title,review.body,now-Math.random()*86400000*30)
      );
    }
  }

  if(statements.length>0)await db.batch(statements);
}
