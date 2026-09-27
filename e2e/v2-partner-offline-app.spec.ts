import {test,expect,type BrowserContext} from "@playwright/test";
import {createHash} from "node:crypto";
import {writeFileSync,mkdirSync} from "node:fs";
import {dirname} from "node:path";
import {createServer} from "node:http";

const provider="launch-offline-provider";
const job={bookingId:"launch-offline-booking",workOrderId:"launch-offline-work",providerId:provider,providerName:"Offline test partner",providerModel:"contract",status:"arrived",workOrderStatus:"arrived",serviceCode:"grooming",packageName:"Test grooming",packageCode:"uat",zoneId:"blr-central",cityId:"blr",scheduledStart:new Date().toISOString(),scheduledEnd:new Date(Date.now()+3600000).toISOString(),totalAmount:1000,currency:"INR",occurrenceCount:1,customer:{id:"fixture-customer",name:"Fixture Customer",maskedPhone:"******0000"},pets:[{id:"fixture-pet",name:"Maya",species:"dog",breed:"Labrador",vaccinationStatus:"verified",safetyNotes:["Sensitive left paw"]}],payment:{method:"sandbox",mode:"prepaid",status:"captured",amount:1000,amountDueNow:0},subscription:null,addOns:[],safetyRequirements:[],events:[],proof:null};
async function fixture(context:BrowserContext,initialStatus:string,useUploadReceiver=false) {
 const state={status:initialStatus,blocked:false,posts:0,registrations:0,uploads:0,sha:"",bytes:0,uploadErrors:[] as string[]};
 // Receive the real binary request over loopback: WebKit's route.postDataBuffer() omits Blob bodies.
 // Assertions belong at the receiving server, not in an inspector that may not expose those bytes.
 const sink=createServer(async(req,res)=>{
  res.setHeader("access-control-allow-origin",req.headers.origin||"*");
  res.setHeader("access-control-allow-credentials","true");
  res.setHeader("access-control-allow-methods","PUT,POST,OPTIONS");
  res.setHeader("access-control-allow-headers",req.headers["access-control-request-headers"]||"*");
  if(req.method==="OPTIONS"){res.writeHead(204);res.end();return;}
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const bytes=Buffer.concat(chunks);
  if(bytes.length!==state.bytes)state.uploadErrors.push(`Received ${bytes.length} bytes; expected ${state.bytes}`);
  if(createHash("sha256").update(bytes).digest("hex")!==state.sha)state.uploadErrors.push("Receiver SHA-256 differs from the registered photo");
  state.uploads++;res.writeHead(state.uploadErrors.length?400:200,{"content-type":"application/json"});
  res.end(JSON.stringify({data:{objectStored:state.uploadErrors.length===0}}));
 });
 await new Promise<void>((resolve,reject)=>{sink.once("error",reject);sink.listen(0,"127.0.0.1",()=>resolve());});
 const address=sink.address();if(!address||typeof address==="string")throw new Error("Local upload sink did not bind");
 const uploadUrl=`http://127.0.0.1:${address.port}/api/service-media/upload`;
 context.on("close",()=>{sink.closeAllConnections();sink.close();});
 await context.route("**/api/**",async route=>{
  const request=route.request(),path=new URL(request.url()).pathname;
  if(state.blocked)return route.abort("internetdisconnected");
  let body:unknown={data:{}};
  if(path==="/api/identity-session")body={data:{subjectType:"provider",subjectId:provider}};
  if(path==="/api/partner-jobs")body={jobs:[{...job,status:state.status,workOrderStatus:state.status}]};
  if(path==="/api/partner-job-feed")body={data:{needsAction:[],today:[],upcoming:[],completed:[],needsOperations:[],past:[]}};
  if(path==="/api/grooming-route")body={data:{destinationAddress:"Test house, Bengaluru",destination:{latitude:12.97,longitude:77.59},navigationUrl:"https://www.google.com/maps/dir/?api=1&destination=12.97,77.59"}};
  if(path==="/api/grooming-lifecycle"){
   if(request.method()==="POST"){state.posts++;expect(request.postDataJSON().checklist).toEqual(["pet_identity","safety_review","safe_setup"]);state.status="in_service";}
   body={data:{booking:{provider_id:provider,status:state.status}}};
  }
  if(path==="/api/service-media"){
   if(request.method()==="POST"){
    state.registrations++;state.sha=request.postDataJSON().sha256;state.bytes=request.postDataJSON().sizeBytes;
    body={data:{id:"fixture-media",upload:{token:"fixture-only",objectKey:"fixture-only"}}};
   }else body={assets:state.uploads?[{id:"fixture-media",purpose:"before_service",proofReady:false,review_status:"pending_review",access_status:"quarantined",scan_status:"pending",created_at:Date.now(),objectStored:true}]:[]};
  }
  if(path==="/api/service-media/upload"){
   if(useUploadReceiver)return route.continue({url:uploadUrl});
   const bytes=request.postDataBuffer();expect(bytes?.length).toBe(state.bytes);
   expect(createHash("sha256").update(bytes!).digest("hex")).toBe(state.sha);
   state.uploads++;body={data:{objectStored:true}};
  }
  if(path==="/api/uat-provider-switch")return route.fulfill({status:404,json:{}});
  await route.fulfill({json:body});
 });
 return state;
}

test("V2 partner UI: offline service update survives an unavailable API and automatically replays",async({page,context})=>{
 const state=await fixture(context,"arrived");await page.goto("/v2/partner");
 await expect(page.getByRole("heading",{name:"Your active job"})).toBeVisible();
 const start=page.getByRole("button",{name:"Start service",exact:true}).first();await expect(start).toBeDisabled();
 for(const label of ["I verified the pet and booked service","I reviewed behaviour, medical and handling notes with the customer","The pet and equipment are safe to begin"])await page.getByRole("checkbox",{name:label}).check();
 state.blocked=true;await context.setOffline(true);await start.click();
 await expect(page.getByText(/1 update\(s\) saved on this device/)).toBeVisible();expect(state.posts).toBe(0);
 // Reload with the network transport restored but the API still unavailable: no offline cold-start claim.
 await context.setOffline(false);await page.reload();
 expect(await page.evaluate(p=>JSON.parse(localStorage.getItem(`pawspace:partner-status:v1:${p}`)||"[]").length,provider)).toBe(1);
 state.blocked=false;await page.reload();
 await expect.poll(()=>state.posts,{timeout:25000}).toBe(1);
 await expect(page.getByText("After-service checklist")).toBeVisible();
 await expect.poll(()=>page.evaluate(p=>JSON.parse(localStorage.getItem(`pawspace:partner-status:v1:${p}`)||"[]").length,provider)).toBe(0);
});

test("V2 partner UI: offline photo automatically uploads the exact bytes once after reconnect",async({page,context,browserName},info)=>{
 const state=await fixture(context,"in_service",browserName==="webkit");await page.goto("/v2/partner");
 await expect(page.getByLabel("Before photo",{exact:true})).toBeVisible();
 state.blocked=true;
 // Playwright WebKit's setOffline also breaks local Blob/File reads (even new Blob(["x"]).text()).
 // Use real API transport failures plus the offline event there; never substitute the selected file.
 // Chromium and Firefox retain the browser's full-network offline emulator.
 if(browserName==="webkit")await page.evaluate(()=>{Object.defineProperty(navigator,"onLine",{configurable:true,get:()=>false});window.dispatchEvent(new Event("offline"));});
 else await context.setOffline(true);
 const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8eoAAAAASUVORK5CYII=","base64");
 const fixtureFile=info.outputPath("offline-proof.png");mkdirSync(dirname(fixtureFile),{recursive:true});writeFileSync(fixtureFile,png);
 await expect.poll(()=>page.evaluate(()=>navigator.onLine)).toBe(false);
 // Exercise the actual file input with bytes on disk, not a mocked File or upload callback.
 await page.getByLabel("Before photo",{exact:true}).setInputFiles(fixtureFile);
 await expect(page.getByText("Proof saved on this device and queued for automatic sync when connectivity returns.")).toBeVisible();
 expect(state.uploads).toBe(0);expect(state.registrations).toBe(0);
 state.blocked=false;
 if(browserName==="webkit")await page.evaluate(()=>{delete (navigator as unknown as {onLine?:boolean}).onLine;window.dispatchEvent(new Event("online"));});
 else await context.setOffline(false);
 await expect.poll(()=>state.uploads,{timeout:25000}).toBe(1);
 expect(state.uploadErrors).toEqual([]);
 await expect(page.getByText("1 queued proof image synced.")).toBeVisible();
 expect(state.registrations).toBe(1);
 await page.reload();await expect(page.getByRole("heading",{name:"Your active job"})).toBeVisible();
 expect(state.uploads).toBe(1);expect(state.registrations).toBe(1);
});
