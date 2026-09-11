export type AtlasAgentCode="atlas"|"sales"|"marketing"|"ops"|"hr"|"finance";
export type AtlasToolNamespace="sales"|"memory"|"vision"|"iot"|"commerce"|"rpa";
export type AtlasToolCode=`${AtlasToolNamespace}.${string}`;
export type AtlasExecutionTarget="canonical_service"|"external_rpa";
export type AtlasNetworkPolicy="none"|"allowlisted_https";

export type AtlasJsonSchema={
 type:"object";
 additionalProperties:false;
 properties:Record<string,unknown>;
 required:string[];
};

export type AtlasToolDefinition<TCode extends AtlasToolCode=AtlasToolCode>={
 code:TCode;
 version:string;
 allowedAgents:AtlasAgentCode[];
 riskClass:"read"|"medium"|"high";
 autonomy:"autonomous"|"within_envelope";
 idempotencyRequired:boolean;
 requiredPermissions:string[];
 inputSchema:AtlasJsonSchema;
 executionTarget:AtlasExecutionTarget;
 networkPolicy:AtlasNetworkPolicy;
};
