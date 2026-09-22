import {serviceProofReleased} from "./service-media-security";

/** Training uses the same release decision as other services, with an explicit independent review. */
export function trainingEvidenceReleased(row:Record<string,unknown>):boolean {
 return serviceProofReleased(row)&&row.review_status==="approved"&&(row.scan_status==="clean"||["permitted_environment","manual_review_policy"].includes(String(row.release_basis)));
}
