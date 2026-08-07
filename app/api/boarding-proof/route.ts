import{authError,database,requireCustomerOwnership,requirePermission,requireProviderOwnership,resolveActor,securityAudit}from"../../../lib/server-auth";
import{hasPermission}from"../../../lib/platform-security";
import{getBoardingProofSnapshot,mutateBoardingProof,type BoardingMediaPurpose,type BoardingProofAction}from"../../../lib/boarding-proof-governance";

type Body={stayId?:string;action?:BoardingProofAction;idempotencyKey?:string;purpose?:BoardingMediaPurpose;mimeType?:string;sizeBytes?:number;sha256?:string;uploadToken?:string;storageObjectId?:string;mediaRef?:string