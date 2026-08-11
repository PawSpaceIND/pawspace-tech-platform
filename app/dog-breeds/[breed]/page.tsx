import type{Metadata}from"next";import{notFound}from"next/navigation";
import{Breadcrumbs,MarketingShell,QuickFacts,DidYouKnow,SectionHeader,Faqs,JsonLd,services as allServices}from"../../components/marketing/premium-marketing";
import styles from"../../components/marketing/premium-marketing.module.css";
import{getBreedGuide,breedGuides}from"../../../lib/breed-content";

const site="https://pawspace.in";

export function generateStaticParams(){return breedGuides.map(item=>({breed:item.slug}))}

export async function generateMetadata({params}:{params:Promise<{breed:string}>}):Promise<Metadata>{
  const{breed}=await params,guide=getBreedGuide(breed);
  if(!guide)return{};
  const url=`${site}/dog-breeds/${guide.slug}`;
  return{title:guide.seoTitle,description:guide.seoDescription,alternates:{canonical:url},openGraph:{title:guide.seoTitle,description:guide.seoDescription,url,siteName:"PawSpace",type:"article"},twitter:{card:"summary_large_image",title:guide.seoTitle,description:guide.seoDescription}};
}

export default async function BreedPage({params}:{params:Promise<{breed:string}>}){
  const{breed}=await params,guide=getBreedGuide(breed);
  if(!guide)notFound();
  const url=`${site}/dog-breeds/${guide.slug}`;
  const article={"@context":"https://schema.org","@type":"Article",headline:`${guide.name} ${guide.species==="cat"?"Cat":"Dog"} Breed Guide`,description:guide.seoDescription,mainEntityOfPage:url,publisher:{"@type":"Organization",name:"PawSpace",url:site}};
  const faq={"@context":"https://schema.org","@type":"FAQPage",mainEntity:guide.faqs.map(x=>({"@type":"Question",name:x.q,acceptedAnswer:{"@type":"Answer",text:x.a}}))};
  const breadcrumb={"@context":"https://schema.org","@type":"BreadcrumbList",itemListElement:[{"@type":"ListItem",position:1,name:"Home",item:`${site}/discover`},{"@type":"ListItem",position:2,name:guide.species==="cat"?"Cat breeds":"Dog breeds",item:`${site}/dog-breeds`},{"@type":"ListItem",position:3,name:guide.name,item:url}]};
  const crossSell=allServices.filter(item=>guide.relevantServices.some(slug=>item.href===`/services/${slug}`));
  return <MarketingShell>
    <JsonLd data={[article,faq,breadcrumb]}/>
    <Breadcrumbs items={[{label:"Home",href:"/discover"},{label:guide.species==="cat"?"Cat breeds":"Dog breeds"},{label:guide.name}]}/>
    <section className={styles.hero}>
      <div>
        <span className={styles.eyebrow}>🐾 {guide.eyebrow}</span>
        <h1>{guide.headline} <em>{guide.accent}</em></h1>
        <p>{guide.intro}</p>
        <div className={styles.actions}><a className={styles.primary} href="/mobile-app">Book a service</a><a className={styles.secondary} href={`tel:+919876543210`}>Call Us: +91 98765 43210</a></div>
      </div>
      <div className={styles.heroVisual}>
        <div className={styles.breedStat}>
          <div className="row" style={{display:"flex",gap:10,alignItems:"flex-start"}}><span>⭐</span><div><b>{guide.rating}</b><span style={{display:"block",fontSize:"11.5px",color:"var(--ps-muted)"}}>Breed Rating</span></div></div>
          <div className="row" style={{display:"flex",gap:10,alignItems:"flex-start"}}><span>🏆</span><div><b style={{fontSize:13}}>{guide.rankLabel}</b></div></div>
          <div className="row" style={{display:"flex",gap:10,alignItems:"flex-start"}}><span>🐾</span><div><b style={{fontSize:13}}>{guide.caredForLabel}</b></div></div>
          <div className="row" style={{display:"flex",gap:10,alignItems:"flex-start"}}><span>♡</span><div><span style={{display:"block",fontSize:"11.5px",color:"var(--ps-muted)"}}>Loved by Pet Parents Across Bangalore</span></div></div>
        </div>
      </div>
    </section>
    <QuickFacts items={guide.facts}/>
    <section className={styles.section}>
      <SectionHeader eyebrow={`Why ${guide.name}s Are So Special`} title="A perfect blend of character, care and companionship."/>
      <div className={styles.grid4}>{guide.whySpecial.map(item=><article className={styles.card} key={item.title}><div className={styles.cardBody}><h3>{item.title}</h3><p>{item.text}</p></div></article>)}</div>
    </section>
    <section className={styles.section}>
      <div className={styles.trust}>
        <div><span className={styles.eyebrow}>Care Guide</span><h2>{`Give your ${guide.name} the best care for a happy, healthy life.`}</h2>
          <div className={styles.checkList}>{guide.careGuide.map(item=><div className={styles.check} key={item.title}><i>✓</i><div><b>{item.title}</b><span>{item.text}</span></div></div>)}</div>
        </div>
        <DidYouKnow text={guide.didYouKnow}/>
      </div>
    </section>
    <section className={styles.section}>
      <SectionHeader eyebrow="PawSpace care" title={`Everything your ${guide.name} needs, all in one place.`}/>
      <div className={styles.grid4}>{crossSell.map(item=><article className={styles.card} key={item.title}><div className={styles.cardBody}><h3>{item.title}</h3><p>{item.description}</p><a className={styles.cardLink} href={item.href}>Explore {item.title} →</a></div></article>)}</div>
    </section>
    <Faqs items={guide.faqs}/>
  </MarketingShell>;
}
