export type TrustedWorkspaceIdentity={email:string;name:string};
const DIRECT_EDGE_SUFFIXES=[".workers.dev",".pages.dev"];
const WORKSPACE_IDENTITY_HEADERS=["oai-authenticated-user-email","oai-authenticated-user-full-name","oai-authenticated-user-full-name-encoding"];

function text(value:unknown){return String(value??"").trim();}
function runtimeText(runtime:Record<string,unknown>,name:string){return text(runtime?.[name]).toLowerCase();}

/**
 * Workspace identity headers are authority only behind the dispatch layer that owns and overwrites them.
 * Declared deployments fail closed unless their runtime explicitly asserts that boundary. This prevents a
 * raw client-supplied oai-authenticated-user-email header from becoming staff authority on a directly
 * reachable Worker. Native/undeclared Sites hosting remains compatible with dispatch-owned injection.
 */
export function trustedWorkspaceHeaderIngress(request:Request,runtime:Record<string,unknown>={}){
 let host="";try{host=new URL(request.url).hostname.toLowerCase();}catch{return false;}
 if(DIRECT_EDGE_SUFFIXES.some(suffix=>host.endsWith(suffix)))return false;
 const deployment=runtimeText(runtime,"PAWSPACE_DEPLOYMENT_ENV");
 if(deployment)return runtimeText(runtime,"PAWSPACE_WORKSPACE_IDENTITY_TRUST")==="openai-dispatch";
 return true;
}

export function resolveTrustedWorkspaceIdentity(request:Request,runtime:Record<string,unknown>={}):TrustedWorkspaceIdentity|null{
 const email=text(request.headers.get("oai-authenticated-user-email")).toLowerCase();
 if(!email||!trustedWorkspaceHeaderIngress(request,runtime))return null;
 const encoded=request.headers.get("oai-authenticated-user-full-name")||"";
 let name=email.split("@")[0]||"Workspace user";
 if(request.headers.get("oai-authenticated-user-full-name-encoding")==="percent-encoded-utf-8"&&encoded){try{name=decodeURIComponent(encoded)}catch{}}
 return{email,name};
}

/** Remove spoofable workspace identity headers before central gateway inspection on untrusted ingress. */
export function requestForAuthorization(request:Request,runtime:Record<string,unknown>={}){
 if(trustedWorkspaceHeaderIngress(request,runtime))return request.clone();
 const headers=new Headers(request.headers);
 for(const name of WORKSPACE_IDENTITY_HEADERS)headers.delete(name);
 return new Request(request,{headers});
}
