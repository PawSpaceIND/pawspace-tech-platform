import type{Metadata}from"next";
import{Breadcrumbs,MarketingShell,ProofStrip,SectionHeader,JsonLd}from"../components/marketing/premium-marketing";
import styles from"../components/marketing/premium-marketing.module.css";

export const metadata:Metadata={title:"Become a PawSpace Caregiver | Careers in Pet Care | PawSpace",description:"Turn your love for pets into meaningful work. Join PawSpace as a groomer, trainer, walker, sitter or host - flexible hours, real pay, real training.",alternates:{canonical:"https://pawspace.in/careers"},openGraph:{title:"Become a PawSpace Caregiver",description:"Flexible pet-care work in Bengaluru - grooming, training, walking, sitting and hosting.",url:"https://pawspace.in/careers",siteName:"PawSpace",type:"website"}};

const roles=[
  {title:"Pet Groomer",text:"Groom pets and keep them clean & happy.",href:"#apply"},
  {title:"Dog Trainer",text:"Train dogs with positive, patient methods.",href:"#apply"},
  {title:"Pet Sitter",text:"Visit pets at home, feed, play and care.",href:"#apply"},
  {title:"Pet Host",text:"Open your home and host pets with love.",href:"#apply"},
  {title:"Pet Carer",text:"Provide daily care, walks and feeding.",href:"#apply"},
];

export default function CareersPage(){
  const jobPostings=roles.map(role=>({"@context":"https://schema.org","@type":"JobPosting",title:role.title,description:role.text,hiringOrganization:{"@type":"Organization",name:"PawSpace",sameAs:"https://pawspace.in"},jobLocation:{"@type":"Place",address:{"@type":"PostalAddress",addressLocality:"Bengaluru",addressRegion:"Karnataka",addressCountry:"IN"}},employmentType:["FULL_TIME","PART_TIME"]}));
  return <MarketingShell>
    <JsonLd data={jobPostings}/>
    <Breadcrumbs items={[{label:"Home",href:"/discover"},{label:"Careers"}]}/>
    <section className={styles.hero}>
      <div>
        <span className={styles.eyebrow}>🐾 PawSpace Careers</span>
        <h1>Work with love. <em>Grow with purpose.</em></h1>
        <p>Join PawSpace and be part of a team that makes a real difference in pets&apos; lives every day - flexible hours, real training, and pay you can rely on.</p>
        <div className={styles.actions}><a className={styles.primary} href="#apply">Explore openings</a><a className={styles.secondary} href="#apply">Apply now</a></div>
      </div>
      <div className={styles.heroVisual}/>
    </section>
    <ProofStrip/>
    <section className={styles.section}>
      <SectionHeader eyebrow="Career opportunities" title="Find the role that matches your passion and skills."/>
      <div className={styles.grid4}>{roles.map(role=><article className={styles.card} key={role.title}><div className={styles.cardBody}><h3>{role.title}</h3><p>{role.text}</p><a className={styles.cardLink} href={role.href}>Apply now →</a></div></article>)}</div>
    </section>
    <section className={styles.section}>
      <SectionHeader eyebrow="Why join PawSpace" title="We take care of our team, so they can take better care of pets."/>
      <div className={styles.grid4}>
        <article className={styles.card}><div className={styles.cardBody}><h3>Purpose-driven work</h3><p>Make a real, positive impact on pets&apos; lives every day.</p></div></article>
        <article className={styles.card}><div className={styles.cardBody}><h3>Flexible schedules</h3><p>Choose hours that suit your lifestyle.</p></div></article>
        <article className={styles.card}><div className={styles.cardBody}><h3>Growth opportunities</h3><p>Learn new skills and grow your career with us.</p></div></article>
        <article className={styles.card}><div className={styles.cardBody}><h3>Training & support</h3><p>We provide real training, tools and ongoing guidance.</p></div></article>
      </div>
    </section>
    <section className={styles.section} id="apply">
      <SectionHeader eyebrow="Apply now" title="Share your details and we'll get in touch."/>
      <div className={styles.trust}>
        <div>
          <p>To apply, head to our provider application - it walks you through the details we need and connects your application straight to our onboarding team.</p>
          <a className={styles.primary} href="/partner/onboarding" style={{marginTop:16,display:"inline-flex"}}>Start your application →</a>
        </div>
        <div>
          <SectionHeader title="What happens next?"/>
          <div className={styles.checkList}>
            <div className={styles.check}><i>1</i><div><b>Application review</b><span>We review your application and details.</span></div></div>
            <div className={styles.check}><i>2</i><div><b>Verification</b><span>We verify your identity and experience.</span></div></div>
            <div className={styles.check}><i>3</i><div><b>Training</b><span>Learn what you need to get started.</span></div></div>
            <div className={styles.check}><i>4</i><div><b>Start earning</b><span>Join our community and start taking bookings.</span></div></div>
          </div>
        </div>
      </div>
    </section>
  </MarketingShell>;
}
