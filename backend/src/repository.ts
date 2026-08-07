import { MongoClient, type Collection, type Db } from "mongodb";
import type { AuditEvent, AutomationEnrollment, Booking, CashCollection, CityPrice, CommunicationPreference, Customer, NotificationEvent, OtpChallenge, Payment, Pet, PlatformRepository, Provider, ProviderAvailability, ProviderEarning, ProviderPayout, Refund, Subscription, SupportTicket, TaxInvoice } from "./domain.js";

const now = new Date().toISOString();
const seedCustomers: Customer[] = [{ id:"cus_10428",legacyIds:["mongo:66a7-meera"],cityId:"blr",type:"subscription",name:"Meera Shah",primaryPhone:"+919876543418",secondaryPhone:"+919900001234",consent:{marketing:true,serviceUpdates:true,capturedAt:now},createdAt:now,updatedAt:now }];
const seedPets: Pet[] = [{ id:"pet_bruno",customerId:"cus_10428",legacyIds:["mongo:pet-bruno"],name:"Bruno",species:"dog",breed:"Golden Retriever",allergies:["Sensitive skin"],behaviourNotes:"Friendly",vaccinationStatus:"verified",createdAt:now,updatedAt:now }];
const seedPrices: CityPrice[] = [
  {id:"price_blr_essential",cityId:"blr",serviceCode:"grooming",packageCode:"essential_bath",name:"Essential Bath",amount:1349,currency:"INR",taxInclusive:true,active:true},
  {id:"price_blr_basic",cityId:"blr",serviceCode:"grooming",packageCode:"bath_basic",name:"Bath & Basic",amount:1899,currency:"INR",taxInclusive:true,active:true},
  {id:"price_blr_makeover",cityId:"blr",serviceCode:"grooming",packageCode:"complete_makeover",name:"Complete Makeover",amount:2399,currency:"INR",taxInclusive:true,active:true},
  {id:"price_blr_trim",cityId:"blr",serviceCode:"grooming",packageCode:"just_trim",name:"Just Trim",amount:1399,currency:"INR",taxInclusive:true,active:true},
  {id:"price_blr_training",cityId:"blr",serviceCode:"dog_training",packageCode:"doorstep_assessment",name:"Doorstep Training Assessment",amount:999,currency:"INR",taxInclusive:true,active:true},
  {id:"price_blr_boarding",cityId:"blr",serviceCode:"boarding",packageCode:"standard_stay",name:"Standard Home Boarding",amount:999,currency:"INR",taxInclusive:true,active:true},
  {id:"price_blr_sitting",cityId:"blr",serviceCode:"pet_sitting",packageCode:"home_visit",name:"Pet Sitting Home Visit",amount:799,currency:"INR",taxInclusive:true,active:true},
  {id:"price_blr_walking",cityId:"blr",serviceCode:"dog_walking",packageCode:"tracked_walk",name:"GPS Tracked Walk",amount:399,currency:"INR",taxInclusive:true,active:true},
  {id:"price_blr_taxi",cityId:"blr",serviceCode:"pet_taxi",packageCode:"city_trip",name:"Pet Taxi City Trip",amount:699,currency:"INR",taxInclusive:true,active:true},
  {id:"price_blr_food_200",cityId:"blr",serviceCode:"fresh_food",packageCode:"fresh_200g",name:"Fresh Dog Food 200 g",amount:149,currency:"INR",taxInclusive:true,active:true},
  {id:"price_blr_food_500",cityId:"blr",serviceCode:"fresh_food",packageCode:"fresh_500g",name:"Fresh Dog Food 500 g",amount:299,currency:"INR",taxInclusive:true,active:true},
];
const seedProviders: Provider[] = [
  {id:"pro_arjun",cityId:"blr",name:"Arjun Kumar",model:"full_time",services:["grooming"],zones:["blr-east"],live:true,rating:4.8,qualityScore:94,capacity:1,travelBufferMinutes:30,maxDailyJobs:4},
  {id:"pro_kiran",cityId:"blr",name:"Kiran S",model:"commission",services:["grooming","dog_training"],zones:["blr-east","blr-south"],live:true,rating:4.7,qualityScore:91,capacity:1,travelBufferMinutes:30,maxDailyJobs:5},
  {id:"pro_nisha",cityId:"blr",name:"Nisha Rao",model:"commission",services:["dog_training"],zones:["blr-east","blr-south"],live:true,rating:4.9,qualityScore:95,capacity:1,travelBufferMinutes:45,maxDailyJobs:4},
  {id:"pro_sanjay",cityId:"blr",name:"Sanjay P",model:"full_time",services:["grooming"],zones:["blr-east"],live:true,rating:4.7,qualityScore:88,capacity:1,travelBufferMinutes:30,maxDailyJobs:4},
  {id:"pro_ramesh",cityId:"blr",name:"Ramesh P",model:"commission",services:["dog_training"],zones:["blr-east"],live:true,rating:4.7,qualityScore:89,capacity:1,travelBufferMinutes:45,maxDailyJobs:4},
  {id:"host_ananya",cityId:"blr",name:"Ananya Pet Home",model:"commission",services:["boarding"],zones:["blr-east"],live:true,rating:4.9,qualityScore:96,capacity:4,travelBufferMinutes:0,maxDailyJobs:12},
  {id:"host_sana",cityId:"blr",name:"Sana Pet Home",model:"commission",services:["boarding"],zones:["blr-east"],live:true,rating:4.8,qualityScore:92,capacity:3,travelBufferMinutes:0,maxDailyJobs:10},
  {id:"host_tara",cityId:"blr",name:"Tara Pet Home",model:"commission",services:["boarding"],zones:["blr-east"],live:true,rating:4.7,qualityScore:89,capacity:3,travelBufferMinutes:0,maxDailyJobs:10},
  {id:"sit_rohit",cityId:"blr",name:"Rohit Sitter",model:"commission",services:["pet_sitting"],zones:["blr-east","blr-south"],live:true,rating:4.8,qualityScore:93,capacity:2,travelBufferMinutes:30,maxDailyJobs:6},
  {id:"sit_neha",cityId:"blr",name:"Neha Sitter",model:"commission",services:["pet_sitting"],zones:["blr-east"],live:true,rating:4.7,qualityScore:90,capacity:3,travelBufferMinutes:30,maxDailyJobs:6},
  {id:"sit_asha",cityId:"blr",name:"Asha Sitter",model:"commission",services:["pet_sitting"],zones:["blr-east"],live:true,rating:4.6,qualityScore:87,capacity:4,travelBufferMinutes:30,maxDailyJobs:6},
];

export class MemoryRepository implements PlatformRepository {
  customers=[...seedCustomers]; pets=[...seedPets]; prices=[...seedPrices]; providers=[...seedProviders]; bookings:Booking[]=[]; subscriptions:Subscription[]=[]; audits:AuditEvent[]=[]; availability:ProviderAvailability[]=[]; notifications:NotificationEvent[]=[]; payments:Payment[]=[]; invoices:TaxInvoice[]=[]; refunds:Refund[]=[]; cashCollections:CashCollection[]=[]; earnings:ProviderEarning[]=[]; payouts:ProviderPayout[]=[]; preferences:CommunicationPreference[]=[]; otpChallenges:OtpChallenge[]=[]; enrollments:AutomationEnrollment[]=[]; tickets:SupportTicket[]=[];
  async findCustomers(query:string,cityId:string){const q=query.toLowerCase();return this.customers.filter(c=>c.cityId===cityId&&`${c.name} ${c.primaryPhone}`.toLowerCase().includes(q));}
  async getCustomer(id:string){return this.customers.find(c=>c.id===id)??null;}
  async createCustomer(customer:Customer){this.customers.push(customer);return customer;}
  async listPets(customerId:string){return this.pets.filter(p=>p.customerId===customerId);}
  async getPet(id:string){return this.pets.find(p=>p.id===id)??null;}
  async createPet(pet:Pet){this.pets.push(pet);return pet;}
  async listPrices(cityId:string,serviceCode?:string){return this.prices.filter(p=>p.cityId===cityId&&p.active&&(!serviceCode||p.serviceCode===serviceCode));}
  async listEligibleProviders(cityId:string,zoneId:string,serviceCode:string){return this.providers.filter(p=>p.cityId===cityId&&p.zones.includes(zoneId)&&p.services.includes(serviceCode)&&p.live).sort((a,b)=>b.qualityScore-a.qualityScore);}
  async getProvider(id:string){return this.providers.find(p=>p.id===id)??null;}
  async upsertAvailability(availability:ProviderAvailability){const index=this.availability.findIndex(x=>x.providerId===availability.providerId&&x.date===availability.date&&x.zoneId===availability.zoneId);if(index>=0)this.availability[index]=availability;else this.availability.push(availability);return availability;}
  async listAvailability(providerId:string,date:string){return this.availability.filter(x=>x.providerId===providerId&&x.date===date);}
  async listBookings(cityId:string,providerId?:string){return this.bookings.filter(x=>x.cityId===cityId&&(!providerId||x.providerId===providerId));}
  async createBooking(booking:Booking){this.bookings.push(booking);return booking;}
  async findBookingByIdempotencyKey(key:string){return this.bookings.find(b=>b.idempotencyKey===key)??null;}
  async getBooking(id:string){return this.bookings.find(b=>b.id===id)??null;}
  async updateBooking(id:string,patch:Partial<Booking>){const found=await this.getBooking(id);if(!found)return null;Object.assign(found,patch);return found;}
  async getSubscription(id:string){return this.subscriptions.find(s=>s.id===id)??null;}
  async createSubscription(subscription:Subscription){this.subscriptions.push(subscription);return subscription;}
  async appendAudit(event:AuditEvent){this.audits.push(event);}
  async listAudit(entityType:string,entityId:string){return this.audits.filter(a=>a.entityType===entityType&&a.entityId===entityId);}
  async enqueueNotification(event:NotificationEvent){this.notifications.push(event);return event;}
  async listNotifications(status?:NotificationEvent["status"]){return this.notifications.filter(x=>!status||x.status===status);}
  async updateNotification(id:string,patch:Partial<NotificationEvent>){const found=this.notifications.find(x=>x.id===id);if(!found)return null;Object.assign(found,patch);return found;}
  async createPayment(payment:Payment){this.payments.push(payment);return payment;}
  async getPayment(id:string){return this.payments.find(x=>x.id===id)??null;}
  async findPaymentByIdempotencyKey(key:string){return this.payments.find(x=>x.idempotencyKey===key)??null;}
  async updatePayment(id:string,patch:Partial<Payment>){const found=await this.getPayment(id);if(!found)return null;Object.assign(found,patch);return found;}
  async createInvoice(invoice:TaxInvoice){this.invoices.push(invoice);return invoice;}
  async getInvoiceByBooking(bookingId:string){return this.invoices.find(x=>x.bookingId===bookingId)??null;}
  async createRefund(refund:Refund){this.refunds.push(refund);return refund;}
  async listRefunds(paymentId?:string){return this.refunds.filter(x=>!paymentId||x.paymentId===paymentId);}
  async createCashCollection(collection:CashCollection){this.cashCollections.push(collection);return collection;}
  async updateCashCollection(id:string,patch:Partial<CashCollection>){const found=this.cashCollections.find(x=>x.id===id);if(!found)return null;Object.assign(found,patch);return found;}
  async listCashCollections(cityId:string){return this.cashCollections.filter(x=>x.cityId===cityId);}
  async createEarning(earning:ProviderEarning){this.earnings.push(earning);return earning;}
  async listEarnings(providerId?:string){return this.earnings.filter(x=>!providerId||x.providerId===providerId);}
  async updateEarning(id:string,patch:Partial<ProviderEarning>){const found=this.earnings.find(x=>x.id===id);if(!found)return null;Object.assign(found,patch);return found;}
  async createPayout(payout:ProviderPayout){this.payouts.push(payout);return payout;}
  async findPayoutByIdempotencyKey(key:string){return this.payouts.find(x=>x.idempotencyKey===key)??null;}
  async listPayouts(providerId?:string){return this.payouts.filter(x=>!providerId||x.providerId===providerId);}
  async upsertCommunicationPreference(preference:CommunicationPreference){const index=this.preferences.findIndex(x=>x.customerId===preference.customerId);if(index>=0)this.preferences[index]=preference;else this.preferences.push(preference);return preference;}
  async getCommunicationPreference(customerId:string){return this.preferences.find(x=>x.customerId===customerId)??null;}
  async createOtpChallenge(challenge:OtpChallenge){this.otpChallenges.push(challenge);return challenge;}
  async getOtpChallenge(id:string){return this.otpChallenges.find(x=>x.id===id)??null;}
  async listOtpChallenges(phoneHash:string){return this.otpChallenges.filter(x=>x.phoneHash===phoneHash);}
  async updateOtpChallenge(id:string,patch:Partial<OtpChallenge>){const found=await this.getOtpChallenge(id);if(!found)return null;Object.assign(found,patch);return found;}
  async createEnrollment(enrollment:AutomationEnrollment){this.enrollments.push(enrollment);return enrollment;}
  async listEnrollments(status?:AutomationEnrollment["status"]){return this.enrollments.filter(x=>!status||x.status===status);}
  async updateEnrollment(id:string,patch:Partial<AutomationEnrollment>){const found=this.enrollments.find(x=>x.id===id);if(!found)return null;Object.assign(found,patch);return found;}
  async createTicket(ticket:SupportTicket){this.tickets.push(ticket);return ticket;}
  async listTickets(status?:SupportTicket["status"]){return this.tickets.filter(x=>!status||x.status===status);}
  async overview(cityId:string){return {customers:this.customers.filter(x=>x.cityId===cityId).length,pets:this.pets.length,bookings:this.bookings.filter(x=>x.cityId===cityId).length,subscriptions:this.subscriptions.filter(x=>x.status==="active").length,gmv:this.bookings.filter(x=>x.cityId===cityId).reduce((s,x)=>s+x.totalAmount,0)};}
  async close(){}
}

export class MongoRepository implements PlatformRepository {
  private constructor(private client:MongoClient,private db:Db){}
  static async connect(uri:string,database:string){const client=new MongoClient(uri,{maxPoolSize:20,minPoolSize:2,retryWrites:true});await client.connect();return new MongoRepository(client,client.db(database));}
  private collection<T extends object>(name:string):Collection<T>{return this.db.collection<T>(name);}
  async findCustomers(query:string,cityId:string){return this.collection<Customer>("customers").find({cityId,$or:[{name:{$regex:query,$options:"i"}},{primaryPhone:{$regex:query}}]}).limit(25).toArray();}
  async getCustomer(id:string){return this.collection<Customer>("customers").findOne({id});}
  async createCustomer(customer:Customer){await this.collection<Customer>("customers").insertOne(customer);return customer;}
  async listPets(customerId:string){return this.collection<Pet>("pets").find({customerId}).toArray();}
  async getPet(id:string){return this.collection<Pet>("pets").findOne({id});}
  async createPet(pet:Pet){await this.collection<Pet>("pets").insertOne(pet);return pet;}
  async listPrices(cityId:string,serviceCode?:string){return this.collection<CityPrice>("city_prices").find({cityId,active:true,...(serviceCode?{serviceCode}:{})}).toArray();}
  async listEligibleProviders(cityId:string,zoneId:string,serviceCode:string){return this.collection<Provider>("providers").find({cityId,zones:zoneId,services:serviceCode,live:true}).sort({qualityScore:-1}).toArray();}
  async getProvider(id:string){return this.collection<Provider>("providers").findOne({id});}
  async upsertAvailability(availability:ProviderAvailability){await this.collection<ProviderAvailability>("provider_availability").updateOne({providerId:availability.providerId,date:availability.date,zoneId:availability.zoneId},{$set:availability},{upsert:true});return availability;}
  async listAvailability(providerId:string,date:string){return this.collection<ProviderAvailability>("provider_availability").find({providerId,date}).toArray();}
  async listBookings(cityId:string,providerId?:string){return this.collection<Booking>("bookings").find({cityId,...(providerId?{providerId}:{})}).toArray();}
  async createBooking(booking:Booking){await this.collection<Booking>("bookings").insertOne(booking);return booking;}
  async findBookingByIdempotencyKey(idempotencyKey:string){return this.collection<Booking>("bookings").findOne({idempotencyKey});}
  async getBooking(id:string){return this.collection<Booking>("bookings").findOne({id});}
  async updateBooking(id:string,patch:Partial<Booking>){return this.collection<Booking>("bookings").findOneAndUpdate({id},{$set:patch},{returnDocument:"after"});}
  async getSubscription(id:string){return this.collection<Subscription>("subscriptions").findOne({id});}
  async createSubscription(subscription:Subscription){await this.collection<Subscription>("subscriptions").insertOne(subscription);return subscription;}
  async appendAudit(event:AuditEvent){await this.collection<AuditEvent>("audit_events").insertOne(event);}
  async listAudit(entityType:string,entityId:string){return this.collection<AuditEvent>("audit_events").find({entityType,entityId}).sort({occurredAt:-1}).toArray();}
  async enqueueNotification(event:NotificationEvent){await this.collection<NotificationEvent>("notification_outbox").insertOne(event);return event;}
  async listNotifications(status?:NotificationEvent["status"]){return this.collection<NotificationEvent>("notification_outbox").find(status?{status}:{}).sort({createdAt:1}).limit(100).toArray();}
  async updateNotification(id:string,patch:Partial<NotificationEvent>){return this.collection<NotificationEvent>("notification_outbox").findOneAndUpdate({id},{$set:patch},{returnDocument:"after"});}
  async createPayment(payment:Payment){await this.collection<Payment>("payments").insertOne(payment);return payment;}
  async getPayment(id:string){return this.collection<Payment>("payments").findOne({id});}
  async findPaymentByIdempotencyKey(idempotencyKey:string){return this.collection<Payment>("payments").findOne({idempotencyKey});}
  async updatePayment(id:string,patch:Partial<Payment>){return this.collection<Payment>("payments").findOneAndUpdate({id},{$set:patch},{returnDocument:"after"});}
  async createInvoice(invoice:TaxInvoice){await this.collection<TaxInvoice>("tax_invoices").insertOne(invoice);return invoice;}
  async getInvoiceByBooking(bookingId:string){return this.collection<TaxInvoice>("tax_invoices").findOne({bookingId});}
  async createRefund(refund:Refund){await this.collection<Refund>("refunds").insertOne(refund);return refund;}
  async listRefunds(paymentId?:string){return this.collection<Refund>("refunds").find(paymentId?{paymentId}:{}).toArray();}
  async createCashCollection(collection:CashCollection){await this.collection<CashCollection>("cash_collections").insertOne(collection);return collection;}
  async updateCashCollection(id:string,patch:Partial<CashCollection>){return this.collection<CashCollection>("cash_collections").findOneAndUpdate({id},{$set:patch},{returnDocument:"after"});}
  async listCashCollections(cityId:string){return this.collection<CashCollection>("cash_collections").find({cityId}).toArray();}
  async createEarning(earning:ProviderEarning){await this.collection<ProviderEarning>("provider_earnings").insertOne(earning);return earning;}
  async listEarnings(providerId?:string){return this.collection<ProviderEarning>("provider_earnings").find(providerId?{providerId}:{}).toArray();}
  async updateEarning(id:string,patch:Partial<ProviderEarning>){return this.collection<ProviderEarning>("provider_earnings").findOneAndUpdate({id},{$set:patch},{returnDocument:"after"});}
  async createPayout(payout:ProviderPayout){await this.collection<ProviderPayout>("provider_payouts").insertOne(payout);return payout;}
  async findPayoutByIdempotencyKey(idempotencyKey:string){return this.collection<ProviderPayout>("provider_payouts").findOne({idempotencyKey});}
  async listPayouts(providerId?:string){return this.collection<ProviderPayout>("provider_payouts").find(providerId?{providerId}:{}).toArray();}
  async upsertCommunicationPreference(preference:CommunicationPreference){await this.collection<CommunicationPreference>("communication_preferences").updateOne({customerId:preference.customerId},{$set:preference},{upsert:true});return preference;}
  async getCommunicationPreference(customerId:string){return this.collection<CommunicationPreference>("communication_preferences").findOne({customerId});}
  async createOtpChallenge(challenge:OtpChallenge){await this.collection<OtpChallenge>("otp_challenges").insertOne(challenge);return challenge;}
  async getOtpChallenge(id:string){return this.collection<OtpChallenge>("otp_challenges").findOne({id});}
  async listOtpChallenges(phoneHash:string){return this.collection<OtpChallenge>("otp_challenges").find({phoneHash}).sort({createdAt:-1}).limit(10).toArray();}
  async updateOtpChallenge(id:string,patch:Partial<OtpChallenge>){return this.collection<OtpChallenge>("otp_challenges").findOneAndUpdate({id},{$set:patch},{returnDocument:"after"});}
  async createEnrollment(enrollment:AutomationEnrollment){await this.collection<AutomationEnrollment>("automation_enrollments").insertOne(enrollment);return enrollment;}
  async listEnrollments(status?:AutomationEnrollment["status"]){return this.collection<AutomationEnrollment>("automation_enrollments").find(status?{status}:{}).toArray();}
  async updateEnrollment(id:string,patch:Partial<AutomationEnrollment>){return this.collection<AutomationEnrollment>("automation_enrollments").findOneAndUpdate({id},{$set:patch},{returnDocument:"after"});}
  async createTicket(ticket:SupportTicket){await this.collection<SupportTicket>("support_tickets").insertOne(ticket);return ticket;}
  async listTickets(status?:SupportTicket["status"]){return this.collection<SupportTicket>("support_tickets").find(status?{status}:{}).toArray();}
  async overview(cityId:string){const [customers,pets,bookings,subscriptions,gmv]=await Promise.all([this.collection<Customer>("customers").countDocuments({cityId}),this.collection<Pet>("pets").countDocuments({}),this.collection<Booking>("bookings").countDocuments({cityId}),this.collection<Subscription>("subscriptions").countDocuments({status:"active"}),this.collection<Booking>("bookings").aggregate<{total:number}>([{$match:{cityId}},{$group:{_id:null,total:{$sum:"$totalAmount"}}}]).next()]);return {customers,pets,bookings,subscriptions,gmv:gmv?.total??0};}
  async close(){await this.client.close();}
}

export async function createRepository():Promise<PlatformRepository>{
  if(process.env.DATABASE_DRIVER!=="mongodb")return new MemoryRepository();
  if(!process.env.MONGODB_URI)throw new Error("MONGODB_URI is required when DATABASE_DRIVER=mongodb");
  return MongoRepository.connect(process.env.MONGODB_URI,process.env.MONGODB_DATABASE??"pawspace");
}
