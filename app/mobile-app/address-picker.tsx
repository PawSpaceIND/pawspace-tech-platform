"use client";
import{useState,useEffect}from"react";
import{resolveServiceCoverage}from"../../lib/service-zone-client";

export type Zone={zoneId:string;zoneName:string;description:string;color:string;serviceAvailable:boolean};
export type ZoneResult={zone:Zone;assignment:{pincode:string;zoneId:string;city:string;area:string};address:string};

const container={maxWidth:600,margin:"0 auto",padding:20,fontFamily:"system-ui",display:"grid",gap:16} as const;
const box={background:"var(--ds-surface)",border:"1px solid var(--ds-border)",borderRadius:"var(--ds-radius-lg)",padding:16,display:"grid",gap:12} as const;
const label={display:"grid",gap:6,fontSize:14,fontWeight:500,color:"var(--ds-text)"} as const;
const input={padding:"12px 14px",borderRadius:"var(--ds-radius-sm)",border:"1px solid var(--ds-border)",fontSize:15,fontFamily:"inherit"} as const;
const button={padding:"12px 20px",borderRadius:"var(--ds-radius-sm)",border:"none",fontSize:15,fontWeight:600,cursor:"pointer",transition:"background 0.2s"} as const;
const primaryButton={...button,background:"var(--ds-primary-500)",color:"#fff"} as const;
const zoneCard={padding:14,borderRadius:"var(--ds-radius-sm)",border:"2px solid var(--ds-border)",background:"var(--ds-surface)",cursor:"pointer",transition:"all 0.2s"} as const;
const zoneCardActive=(color:string)=>({...zoneCard,borderColor:color,background:`${color}11`}) as const;
const badge={display:"inline-block",padding:"4px 8px",borderRadius:"var(--ds-radius-sm)",fontSize:12,fontWeight:600,textTransform:"uppercase"} as const;

export default function AddressPicker({onZoneResolved}:{onZoneResolved?:(zone:ZoneResult|null)=>void}){
  const[address,setAddress]=useState("");
  const[pincode,setPincode]=useState("");
  const[resolvedZone,setResolvedZone]=useState<ZoneResult|null>(null);
  const[zones,setZones]=useState<Zone[]>([]);
  const[loading,setLoading]=useState(false);
  const[error,setError]=useState("");

  useEffect(()=>{
    async function loadZones(){
      try{
        const r=await fetch("/api/service-zone?action=list");
        const body=await r.json() as{data?:Zone[];error?:string};
        if(body.data)setZones(body.data);
      }catch(e){
        console.error("Failed to load zones:",e);
      }
    }
    loadZones();
  },[]);

  async function resolveZone(){
    setError("");setLoading(true);
    try{
      if(address.trim().length<8){setError("Enter the complete doorstep address");return;}
      if(!/^\d{6}$/.test(pincode)){setError("Please enter a valid 6-digit pincode");return;}
      const coverage=await resolveServiceCoverage(pincode);
      const zone=zones.find(item=>item.zoneId===coverage.zoneId);
      if(!zone){setError("The resolved service zone is not enabled in this UAT build");return;}
      const result:ZoneResult={zone,assignment:{pincode:coverage.pincode,zoneId:coverage.zoneId,city:coverage.city,area:coverage.area},address:address.trim()};
      setResolvedZone(result);
      onZoneResolved?.(result);
    }catch(e){
      setError(e instanceof Error?e.message:"Failed to resolve zone");
    }finally{
      setLoading(false);
    }
  }

  return<div style={container}>
    <section style={box}>
      <label style={label}>
        Service area lookup
        <p style={{fontSize:13,color:"var(--ds-text-muted)",margin:0}}>Enter your 6-digit postal code to check service availability and zone</p>
      </label>
      <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:8}}>
        <input
          style={input}
          type="text"
          placeholder="House / flat, street and landmark"
          value={address}
          onChange={e=>{setAddress(e.target.value);setResolvedZone(null);onZoneResolved?.(null);}}
          disabled={loading}
          aria-label="Complete doorstep address"
        />
        <input
          style={input}
          type="text"
          inputMode="numeric"
          placeholder="e.g., 560034"
          value={pincode}
          onChange={e=>{setPincode(e.target.value.replace(/\D/g,"").slice(0,6));setResolvedZone(null);onZoneResolved?.(null);}}
          disabled={loading}
        />
        <button
          style={primaryButton}
          onClick={()=>void resolveZone()}
          disabled={loading||address.trim().length<8||pincode.length!==6}
        >
          {loading?"…":"Check"}
        </button>
      </div>
      {error&&<p role="alert" style={{color:"var(--ds-danger-500)",fontSize:14,margin:0}}>{error}</p>}
    </section>

    {resolvedZone&&<section style={box}>
      <p style={{margin:0,fontSize:13,color:"var(--ds-text-muted)"}}>Your service zone</p>
      <div style={{...zoneCardActive(resolvedZone.zone.color),padding:16}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"start",gap:12}}>
          <div>
            <h3 style={{margin:"0 0 4px 0",fontSize:16,color:"var(--ds-text)"}}>{resolvedZone.zone.zoneName}</h3>
            <p style={{margin:0,fontSize:13,color:"var(--ds-text-muted)"}}>{resolvedZone.zone.description}</p>
            <p style={{margin:"8px 0 0 0",fontSize:13,color:"var(--ds-text)"}}>📍 {resolvedZone.assignment.area}, {resolvedZone.assignment.city}</p>
          </div>
          <span style={{...badge,background:resolvedZone.zone.color,color:"#fff"}}>
            {resolvedZone.zone.serviceAvailable?"✓ Available":"Not available"}
          </span>
        </div>
      </div>
    </section>}

    {zones.length>0&&!resolvedZone&&<section style={box}>
      <p style={{margin:0,fontSize:13,color:"var(--ds-text-muted)"}}>Configured UAT service zones</p>
      <div style={{display:"grid",gap:8}}>
        {zones.map(zone=><div
          key={zone.zoneId}
          style={zoneCard}
          aria-disabled="true"
        >
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12}}>
            <div>
              <h4 style={{margin:"0 0 4px 0",fontSize:14,fontWeight:600}}>{zone.zoneName}</h4>
              <p style={{margin:0,fontSize:12,color:"var(--ds-text-muted)"}}>{zone.description}</p>
            </div>
            <span style={{fontSize:20}}>{zone.color}</span>
          </div>
        </div>)}
      </div>
    </section>}
  </div>;
}
