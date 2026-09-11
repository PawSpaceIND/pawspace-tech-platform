"use client";
import { useEffect, useState } from "react";
import styles from "./host-trust-panel.module.css";

type Badge={id:string;name:string;description:string;icon:string;earnedAt:number|null};
type Review={id:string;hostProviderId:string;customerId:string;bookingId:string;serviceCode:string;rating:1|2|3|4|5;title:string;body:string;createdAt:number;replies:Array<{replyBody:string;createdAt:number}>};
type HostTrustData={hostProviderId:string;stats:{completedStays:number;repeatCustomers:number;yearsHosting:number;avgRating:number;totalReviews:number;acceptanceTimeout:number;medicationSupport:boolean;homeVerified:boolean;kycVerified:boolean;hostCancelledCount:number};badges:Badge[];reviews:Review[];aggregateStats:{avgRating:number;totalReviews:number;ratingHistogram:Record<string,number>}};

export default function HostTrustPanel({hostProviderId}:{hostProviderId:string}){
  const [data,setData]=useState<HostTrustData|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [page,setPage]=useState(0);
  const pageSize=5;

  useEffect(()=>{
    async function load(){
      setLoading(true); setError("");
      try{
        const r=await fetch(`/api/host-trust?hostProviderId=${encodeURIComponent(hostProviderId)}&limit=${pageSize}&offset=${page*pageSize}`);
        const body=await r.json() as {data?:HostTrustData;error?:string};
        if(!r.ok||!body.data){setError(body.error||"Failed to load host trust data");return;}
        setData(body.data);
      }catch(e){setError(e instanceof Error?e.message:"Failed to load host trust data");}
      finally{setLoading(false);}
    }
    void load();
  },[hostProviderId,page]);

  if(loading)return <div className={styles.container}><p>Loading host trust data…</p></div>;
  if(error)return <div className={styles.container}><p role="alert" className={styles.error}>{error}</p></div>;
  if(!data)return <div className={styles.container}><p>No data available</p></div>;

  const maxCount=Math.max(...Object.values(data.aggregateStats.ratingHistogram),1);
  const stars=(rating:number)=>"★".repeat(rating)+"☆".repeat(5-rating);

  return <div className={styles.container}>
    {data.badges.length>0&&<section className={styles.section}>
      <p className={styles.sectionTitle}>Badges & Achievements</p>
      <div className={styles.badgesRow}>{data.badges.map(b=><div key={b.id} className={styles.badge} title={b.description}>{b.icon}{b.name}</div>)}</div>
    </section>}

    <section className={styles.section}><div className={styles.statsStrip}>
      <div className={styles.statBox}><p className={styles.statValue}>{data.stats.completedStays}</p><p className={styles.statLabel}>Stays Hosted</p></div>
      <div className={styles.statBox}><p className={styles.statValue}>{data.stats.repeatCustomers}</p><p className={styles.statLabel}>Repeat Families</p></div>
      <div className={styles.statBox}><p className={styles.statValue}>{data.aggregateStats.avgRating.toFixed(1)}</p><p className={styles.statLabel}>Avg Rating</p></div>
    </div></section>

    {data.aggregateStats.totalReviews>0&&<section className={styles.section}>
      <p className={styles.sectionTitle}>Rating Distribution ({data.aggregateStats.totalReviews} reviews)</p>
      <div className={styles.histogramRow}>{[5,4,3,2,1].map(rating=><div key={rating} className={styles.histogramBar}>
        <progress className={styles.ratingProgress} max={maxCount} value={Math.max(1,Number(data.aggregateStats.ratingHistogram[rating]||0))} title={`${data.aggregateStats.ratingHistogram[rating]||0} reviews`}/>
        <span className={styles.histogramLabel}>{rating}★</span>
      </div>)}</div>
    </section>}

    {data.reviews.length>0&&<section className={styles.section}>
      <p className={styles.sectionTitle}>Recent Reviews</p>
      <div className={styles.reviewList}>{data.reviews.map(review=><div key={review.id} className={styles.reviewBox}>
        <div className={styles.reviewHeader}>
          <div><p className={styles.ratingStars}>{stars(review.rating)}</p><h4 className={styles.reviewTitle}>{review.title}</h4></div>
          <p className={styles.reviewMeta}>{new Date(review.createdAt).toLocaleDateString()}</p>
        </div>
        <p className={styles.reviewBody}>{review.body}</p>
        {review.replies.length>0&&<div className={styles.replies}>
          <p className={styles.replyLabel}>Host Reply:</p>
          {review.replies.map((reply,idx)=><p key={idx} className={styles.replyBody}>{reply.replyBody}</p>)}
        </div>}
      </div>)}</div>

      {data.aggregateStats.totalReviews>pageSize&&<div className={styles.pagination}>
        <button className={styles.pageButton} disabled={page===0} onClick={()=>setPage(Math.max(0,page-1))}>← Previous</button>
        <span className={styles.pageState}>Page {page+1} of {Math.ceil(data.aggregateStats.totalReviews/pageSize)}</span>
        <button className={styles.pageButton} disabled={(page+1)*pageSize>=data.aggregateStats.totalReviews} onClick={()=>setPage(page+1)}>Next →</button>
      </div>}
    </section>}

    {data.reviews.length===0&&data.aggregateStats.totalReviews===0&&<section className={styles.section}>
      <p className={styles.empty}>No reviews yet. Be the first to leave one!</p>
    </section>}
  </div>;
}
