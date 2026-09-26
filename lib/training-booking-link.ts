/**
 * The Training booking link sales share with a Training lead (founder decision 26 Sep 2026): the ordinary
 * customer booking page, and a WhatsApp click-to-chat URL staff open from their own phone. PawSpace sends
 * nothing itself; these only build the text and the link.
 */
export function trainingBookingLinkMessage(name:string,origin:string){
 const first=String(name||"").trim().split(/\s+/)[0]||"there";
 return `Hi ${first}, here is your PawSpace Dog Training booking link: ${String(origin).replace(/\/+$/,"")}/v2/training?source=crm\nChoose a plan, your trainer and dates, then pay in full or 50% now.`;
}
/** A wa.me link for an Indian mobile number (last 10 digits), or null when the number is not a full mobile. */
export function trainingBookingWhatsAppUrl(phone:string,message:string){
 const digits=String(phone||"").replace(/\D/g,"").slice(-10);
 return /^[6-9]\d{9}$/.test(digits)?`https://wa.me/91${digits}?text=${encodeURIComponent(message)}`:null;
}
