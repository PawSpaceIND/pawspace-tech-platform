import{testCustomers,type TestService}from"./pawspace-test-data";
export type RegressionResult={customerId:string;customer:string;service:TestService;checks:number;passed:number;status:"passed"|"failed";notes:string[]};
const services:TestService[]=["Grooming","Dog Training","Boarding","Pet Sitting","Pet Taxi","Dog Walking","Fresh Food","Relocation"];
export function runSyntheticRegression(){
  const ids=new Set<string>();const results:RegressionResult[]=testCustomers.map(customer=>{const checks=[
    [!ids.has(customer.id),"Duplicate customer ID"],[/^TST-\d{3}$/.test(customer.id),"Invalid test ID"],[customer.primary.replace(/\D/g,"").length===10,"Primary number invalid"],
    [customer.secondary.replace(/\D/g,"").length===10,"Secondary number invalid"],[customer.petCount>=1&&customer.petCount<=4,"Pet-count rule failed"],[customer.pets.split(", ").length===customer.petCount,"Linked pets mismatch"],
    [services.includes(customer.service),"Unknown service"],[customer.amount>0,"Price missing"],[Boolean(customer.area),"Area missing"],[customer.segment!=="Subscriber"||(customer.payment==="Subscription credit"&&customer.credits>0),"Subscription wallet invalid"],
  ] as [boolean,string][];ids.add(customer.id);const notes=checks.filter(item=>!item[0]).map(item=>item[1]);return{customerId:customer.id,customer:customer.name,service:customer.service,checks:checks.length,passed:checks.filter(item=>item[0]).length,status:notes.length?"failed":"passed",notes};});
  const byService=services.map(service=>{const rows=results.filter(item=>item.service===service);return{service,customers:rows.length,checks:rows.reduce((sum,item)=>sum+item.checks,0),passed:rows.every(item=>item.status==="passed")};});
  return{results,byService,totals:{customers:results.length,checks:results.reduce((sum,item)=>sum+item.checks,0),passedCustomers:results.filter(item=>item.status==="passed").length,failedCustomers:results.filter(item=>item.status==="failed").length,services:byService.length}};
}
export const regressionReport=runSyntheticRegression();
