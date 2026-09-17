/** Central response hardening for every PawSpace /api/* path, including authorization failures. */
export function secureApiResponse(response:Response){
 const secured=new Response(response.body,response);
 secured.headers.set("cache-control","no-store");
 secured.headers.set("x-content-type-options","nosniff");
 // Stateless payment-return routes carry receipt parameters; preserve their stricter policy.
 if(secured.headers.get("referrer-policy")!=="no-referrer")secured.headers.set("referrer-policy","same-origin");
 return secured;
}
