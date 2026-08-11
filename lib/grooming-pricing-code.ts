export function groomingPricingPackageCode(packageCode:string,petCount:number){
  const count=Math.max(1,Math.floor(Number(petCount)||1));
  return count===1?packageCode:`${packageCode}__${count}_pets`;
}
