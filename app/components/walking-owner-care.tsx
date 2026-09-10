import {normalizeWalkingOwnerCare} from "../../lib/walking-owner-care";
export default function WalkingOwnerCareSummary({care}:{care:unknown}) {
 let saved; try {saved=normalizeWalkingOwnerCare(care)} catch {saved=null}
 const labels={owner:"Owner",building_staff:"Building staff",secure_key:"Secure key access"};
 return <section style={{padding:16,overflowWrap:"anywhere"}}><h2>Owner’s walking instructions</h2><p style={{whiteSpace:"pre-wrap"}}>{saved?.instructions || "No walking instructions were recorded."}</p><p>Handover preference: {saved?.handoverPreference?labels[saved.handoverPreference]:"Not specified"}</p><small>A preference does not confirm access approval or completed handover. Follow PawSpace handover verification.</small></section>;
}
