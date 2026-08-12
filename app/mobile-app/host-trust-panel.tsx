"use client";
import{useState,useEffect}from"react";

type Badge={id:string;name:string;description:string;icon:string;earnedAt:number|null};
type Review={id:string;hostProviderId:string;customerId:string;bookingId:string;serviceCode:string;rating:1|2|3|4|5;title:string;body:string;createdAt:number;replies:Array<{replyBody:string;createdAt:number}>};
type HostTrustData={hostProviderId:string;stats:{completedStays:number;repeatCustomers:number;yearsHosting:number;avgRating:number;totalReviews:number;acceptanceTimeout:number;medicationSupport:boolean;homeVerified:boolean;kycVerified:boolean;hostCancelledCount:number};badges:Badge[];reviews:Review[];aggregateStats:{avgRating:number;totalReviews:number;ratingHistogram:Record<string,number>}};

const container={maxWidth:800,margin:"0 auto",padding:16,fontFamily:"system-ui",display:"grid",gap:16} as const;
const section={background:"var(--ds-surface)",border:"1px solid var(--ds-border)",borderRadius:"var(--ds-radius-lg)",padding:16,display:"grid",gap:12} as const;
const sectionTitle={fontSize:14,fontWeight:600,color:"var(--ds-text-muted)",textTransform:"uppercase",letterSpacing:0.5,margin:0} as const;
const badgesRow={display:"flex",flexWrap:"wrap",gap:8} as const;
const badge={display:"inline-flex",alignItems:"center",gap:6,padding:"8px 12px",borderRadius:"var(--ds-radius-sm)",background:"var(--ds-primary-500)",color:"#fff",fontSize:13,fontWeight:600} as const;
const statsStrip={display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12} as const;
const statBox={background:"var(--ds-background)",border:"1px solid var(--ds-border)",borderRadius:"var(--ds-radius-sm)",padding:12,textAlign:"center"} as const;
const statValue={fontSize:20,fontWeight:700,color:"var(--ds-primary-500)",margin:"0 0 4px 0"} as const;
const statLabel={fontSize:12,color:"var(--ds-text-muted)",margin:0} as const;
const histogramRow={display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:6} as const;
const histogramBar={display:"grid",gap:4,alignItems:"flex-end"} as const;
const bar={height:60,background:"var(--ds-primary-500)",borderRadius:"var(--ds-radius-sm)",transition:"opacity 0.2s"} as const;
const reviewBox={background:"var(--ds-background)",border:"1px solid var(--ds-border)",borderRadius:"var(--ds-radius-sm)",padding:12,display:"grid",gap:8} as const;
const reviewHeader={display:"flex",justifyContent:"space-between",alignItems:"flex-start"} as const;
const ratingStars={fontSize:16} as const;
const reviewMeta={fontSize:12,color:"var(--ds-text-muted)"} as const;

export default function HostTrustPanel({hostProviderId}:{hostProviderId:string}){
  const[data,setData]=useState<HostTrustData|null>(null);
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState("");
  const[page,setPage]=useState(0);
  const pageSize=5;

  useEffect(()=>{
    async function load(){
      setLoading(true);
      setError("");
      try{
        const r=await fetch(`/api/host-trust?hostProviderId=${encodeURIComponent(hostProviderId)}&limit=${pageSize}&offset=${page*pageSize}`);
        const body=await r.json() as{data?:HostTrustData;error?:string};
        if(!r.ok||!body.data){
          setError(body.error||"Failed to load host trust data");
          return;
        }
        setData(body.data);
      }catch(e){
        setError(e instanceof Error?e.message:"Failed to load host trust data");
      }finally{
        setLoading(false);
      }
    }
    load();
  },[hostProviderId,page]);

  if(loading)return<div style={container}><p>Loading host trust data…</p></div>;
  if(error)return<div style={container}><p role="alert" style={{color:"var(--ds-danger-500)"}}>{error}</p></div>;
  if(!data)return<div style={container}><p>No data available</p></div>;

  const maxCount=Math.max(...Object.values(data.aggregateStats.ratingHistogram),1);
  const stars=(rating:number)=>"★".repeat(rating)+"☆".repeat(5-rating);

  return<div style={container}>
    {/* Badges */}
    {data.badges.length>0&&<section style={section}>
      <p style={sectionTitle}>Badges & Achievements</p>
      <div style={badgesRow}>
        {data.badges.map(b=><div key={b.id} style={badge} title={b.description}>{b.icon}{b.name}</div>)}
      </div>
    </section>}

    {/* Stats Strip */}
    <section style={section}>
      <div style={statsStrip}>
        <div style={statBox}>
          <p style={statValue}>{data.stats.completedStays}</p>
          <p style={statLabel}>Stays Hosted</p>
        </div>
        <div style={statBox}>
          <p style={statValue}>{data.stats.repeatCustomers}</p>
          <p style={statLabel}>Repeat Families</p>
        </div>
        <div style={statBox}>
          <p style={statValue}>{data.aggregateStats.avgRating.toFixed(1)}</p>
          <p style={statLabel}>Avg Rating</p>
        </div>
      </div>
    </section>

    {/* Rating Histogram */}
    {data.aggregateStats.totalReviews>0&&<section style={section}>
      <p style={sectionTitle}>Rating Distribution ({data.aggregateStats.totalReviews} reviews)</p>
      <div style={histogramRow}>
        {[5,4,3,2,1].map(rating=><div key={rating} style={histogramBar}>
          <div style={{...bar,height:`${Math.max(20,(Number(data.aggregateStats.ratingHistogram[rating]||0)/maxCount)*60)}px`}} title={`${data.aggregateStats.ratingHistogram[rating]||0} reviews`}/>
          <span style={{fontSize:12,textAlign:"center",fontWeight:600}}>{rating}★</span>
        </div>)}
      </div>
    </section>}

    {/* Reviews List */}
    {data.reviews.length>0&&<section style={section}>
      <p style={sectionTitle}>Recent Reviews</p>
      <div style={{display:"grid",gap:8}}>
        {data.reviews.map(review=><div key={review.id} style={reviewBox}>
          <div style={reviewHeader}>
            <div>
              <p style={{...ratingStars,margin:0}}>{stars(review.rating)}</p>
              <h4 style={{margin:"4px 0 0 0",fontSize:14,fontWeight:600}}>{review.title}</h4>
            </div>
            <p style={reviewMeta}>{new Date(review.createdAt).toLocaleDateString()}</p>
          </div>
          <p style={{margin:0,fontSize:13,lineHeight:1.5,color:"var(--ds-text)"}}>{review.body}</p>
          {review.replies.length>0&&<div style={{paddingTop:8,borderTop:"1px solid var(--ds-border)"}}>
            <p style={{fontSize:12,fontWeight:600,color:"var(--ds-text-muted)",margin:"0 0 6px 0"}}>Host Reply:</p>
            {review.replies.map((reply,idx)=><p key={idx} style={{margin:0,fontSize:12,color:"var(--ds-text)"}}>{reply.replyBody}</p>)}
          </div>}
        </div>)}
      </div>

      {/* Pagination */}
      {data.aggregateStats.totalReviews>pageSize&&<div style={{display:"flex",justifyContent:"center",gap:8,marginTop:12}}>
        <button
          style={{padding:"8px 12px",borderRadius:"var(--ds-radius-sm)",border:"1px solid var(--ds-border)",background:"var(--ds-surface)",cursor:"pointer"}}
          disabled={page===0}
          onClick={()=>setPage(Math.max(0,page-1))}
        >
          ← Previous
        </button>
        <span style={{display:"flex",alignItems:"center",fontSize:13,color:"var(--ds-text-muted)"}}>
          Page {page+1} of {Math.ceil(data.aggregateStats.totalReviews/pageSize)}
        </span>
        <button
          style={{padding:"8px 12px",borderRadius:"var(--ds-radius-sm)",border:"1px solid var(--ds-border)",background:"var(--ds-surface)",cursor:"pointer"}}
          disabled={(page+1)*pageSize>=data.aggregateStats.totalReviews}
          onClick={()=>setPage(page+1)}
        >
          Next →
        </button>
      </div>}
    </section>}

    {data.reviews.length===0&&data.aggregateStats.totalReviews===0&&<section style={section}>
      <p style={{margin:0,color:"var(--ds-text-muted)"}}>No reviews yet. Be the first to leave one!</p>
    </section>}
  </div>;
}
