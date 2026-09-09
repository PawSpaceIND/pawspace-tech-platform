export function schedulingRuleInput(input:{name:string;service:string;zone:string;field:string;value:string}){
 const name=input.name.trim(),raw=input.value.trim();
 if(!name||name.length>160||!raw||!['grooming','dog_training','boarding','pet_sitting'].includes(input.service)||!['blr-east','blr-south','all'].includes(input.zone))return null;
 const value=input.field==='model'?raw:Number(raw);
 if(input.field==='model'){if(!['full_time','commission'].includes(raw))return null;}
 else{
   if(!['rating','qualityScore','capacity'].includes(input.field)||!Number.isFinite(value)||Number(value)<0)return null;
   if(input.field==='rating'&&Number(value)>5||input.field==='qualityScore'&&Number(value)>100||input.field==='capacity'&&(!Number.isInteger(value)||Number(value)<1))return null;
 }
 return {name,serviceCode:input.service,cityId:'blr',zoneId:input.zone==='all'?null:input.zone,conditions:[{code:`custom_${input.field}`,field:input.field,operator:input.field==='model'?'eq':'gte',value}]};
}
