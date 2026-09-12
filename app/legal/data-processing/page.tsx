export const metadata = { title: "Data Processing & Sub-processors | PawSpace" };

const categories = [
  ["Cloud hosting and edge services", "Application hosting, storage, networking, security and observability"],
  ["Payment processors", "Payment authorisation, capture, settlement, refund and reconciliation"],
  ["Communications providers", "Transactional WhatsApp, SMS, email and voice communications"],
  ["Maps and location providers", "Address lookup, maps, route and location-enabled service operations"],
  ["Identity and verification providers", "Identity, KYC and provider verification where enabled"],
  ["AI and automation providers", "Assisted support, classification, summarisation and approved AI features"],
];

export default function DataProcessingPage() {
  return (
    <>
      <h1>Data Processing &amp; Sub-processors</h1>
      <p><strong>Effective date:</strong> 12 September 2026</p>
      <p>This page describes PawSpace&apos;s baseline data-processing commitments and the categories of third parties that may process personal data on our behalf. Contract-specific DPAs may supplement these terms.</p>
      <h2>1. Processing commitments</h2>
      <p>Where PawSpace acts as a processor or engages a sub-processor, processing is limited to documented purposes and lawful instructions. We apply confidentiality, access control, data-minimisation, retention, security, and incident-management requirements appropriate to the processing.</p>
      <h2>2. Sub-processor due diligence</h2>
      <p>Before enabling a material sub-processor for production personal data, PawSpace assesses the service&apos;s purpose, data access, security posture, contractual protections, retention behaviour, and applicable transfer or localisation requirements.</p>
      <h2>3. Current sub-processor categories</h2>
      <div className="legal-table-wrap">
        <table>
          <thead><tr><th>Category</th><th>Purpose</th></tr></thead>
          <tbody>{categories.map(([category, purpose]) => <tr key={category}><td>{category}</td><td>{purpose}</td></tr>)}</tbody>
        </table>
      </div>
      <p>Specific vendors are enabled only when operationally required and approved. Customers requiring a contract-specific vendor schedule may request the current production list at <a href="mailto:connect@pawspace.in">connect@pawspace.in</a>.</p>
      <h2>4. Confidentiality and security</h2>
      <p>Personnel and vendors with authorised access are subject to confidentiality obligations. PawSpace uses safeguards intended to prevent unauthorised access, alteration, disclosure, loss, or destruction, and requires processors to maintain appropriate protections.</p>
      <h2>5. Data-subject requests</h2>
      <p>Where PawSpace processes data on another organisation&apos;s documented instructions, we will provide reasonable assistance with verified data-subject requests, taking account of the nature of the processing and the information available to us.</p>
      <h2>6. Security incidents</h2>
      <p>PawSpace maintains processes to identify, investigate, contain, remediate, and document material personal-data incidents and to support legally required notifications without undue delay.</p>
      <h2>7. Deletion and return</h2>
      <p>At the end of an applicable processing relationship, personal data is deleted or returned as required by contract and law, except where continued retention is legally required or necessary to establish, exercise, or defend legal claims.</p>
      <h2>8. Sub-processor changes</h2>
      <p>Material changes to production sub-processors will be managed through PawSpace&apos;s vendor-governance process. Where a contract requires notice or an objection mechanism, that contract controls.</p>
    </>
  );
}
