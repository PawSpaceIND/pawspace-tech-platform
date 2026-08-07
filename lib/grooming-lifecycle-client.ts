export type GroomingLifecycleAction="accept"|"on_the_way"|"arrived"|"start_service"|"add_proof"|"complete"|"mark_paid";

export type GroomingLifecycleInput={
  bookingId:string;
  action:GroomingLifecycleAction;
  actorId?:string;
  beforePhotoRef?:string;
  afterPhotoRef?:string;
  checklist?:string[];
  completionNotes?:string;
  paymentReference?:string;
};

export type GroomingLifecycleBundle={
  booking:Record<string,unknown>;
  proof?:Record<string,unknown>|null;
  invoice?:Record<string,unknown>|null;
  subscriptionUsage?:Record<string,unknown>|null;
  repeatTask?:Record<string,unknown>|null;
  events:Array<Record<string,unknown>>;
};

export async function updateGroomingLifecycle(input:GroomingLifecycleInput){
  const response=await fetch("/api/grooming-lifecycle",{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify(input),
  });
  const body=await response.json() as {data?:GroomingLifecycleBundle;error?:string};
  if(!response.ok||!body.data)throw new Error(body.error??"Unable to update Grooming lifecycle");
  return body.data;
}

export async function getGroomingLifecycle(bookingId:string){
  const response=await fetch(`/api/grooming-lifecycle?bookingId=${encodeURIComponent(bookingId)}`);
  const body=await response.json() as {data?:GroomingLifecycleBundle;error?:string};
  if(!response.ok||!body.data)throw new Error(body.error??"Unable to load Grooming lifecycle");
  return body.data;
}
