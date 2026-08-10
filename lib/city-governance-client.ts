import type{CityLaunchConfig,CityLaunchConfigInput}from"./city-governance";

async function payload(response:Response){const body=await response.json().catch(()=>({})) as Record<string,unknown>;if(!response.ok)throw new Error(String(body.error||"City launch request failed"));return body.data;}

export async function loadCityLaunchConfigs(){return payload(await fetch("/api/city-governance",{cache:"no-store"})) as Promise<CityLaunchConfig[]>;}

export async function saveCityLaunchConfig(city:CityLaunchConfigInput){return payload(await fetch("/api/city-governance",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"save_city",city})})) as Promise<CityLaunchConfig>;}
