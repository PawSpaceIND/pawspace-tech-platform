import Link from "next/link";

export default function PartnerPrototypeLayout({children}:{children:React.ReactNode}){
  return <>
    <div role="status" style={{padding:"12px 18px",borderBottom:"2px solid currentColor",fontFamily:"system-ui"}}>
      <strong>SYNTHETIC REGRESSION PROTOTYPE — NOT PROVIDER UAT.</strong>{" "}
      This legacy surface contains fixed demonstration data and must not be used as evidence of verification, activation, marketplace availability, earnings, payouts, ratings or live booking eligibility.{" "}
      <Link href="/partner">Open canonical Partner UAT →</Link>
    </div>
    {children}
  </>;
}
