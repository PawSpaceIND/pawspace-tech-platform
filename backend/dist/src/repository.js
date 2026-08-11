import { MongoClient } from "mongodb";
const now = new Date().toISOString();
const seedCustomers = [{ id: "cus_10428", legacyIds: ["mongo:66a7-meera"], cityId: "blr", type: "subscription", name: "Meera Shah", primaryPhone: "+919876543418", secondaryPhone: "+919900001234", consent: { marketing: true, serviceUpdates: true, capturedAt: now }, createdAt: now, updatedAt: now }];
const seedPets = [{ id: "pet_bruno", customerId: "cus_10428", legacyIds: ["mongo:pet-bruno"], name: "Bruno", species: "dog", breed: "Golden Retriever", allergies: ["Sensitive skin"], behaviourNotes: "Friendly", vaccinationStatus: "verified", createdAt: now, updatedAt: now }];
const seedPrices = [
    { id: "price_blr_essential", cityId: "blr", serviceCode: "grooming", packageCode: "essential_bath", name: "Essential Bath", amount: 1349, currency: "INR", taxInclusive: true, active: true },
    { id: "price_blr_basic", cityId: "blr", serviceCode: "grooming", packageCode: "bath_basic", name: "Bath & Basic", amount: 1899, currency: "INR", taxInclusive: true, active: true },
    { id: "price_blr_makeover", cityId: "blr", serviceCode: "grooming", packageCode: "complete_makeover", name: "Complete Makeover", amount: 2399, currency: "INR", taxInclusive: true, active: true },
    { id: "price_blr_trim", cityId: "blr", serviceCode: "grooming", packageCode: "just_trim", name: "Just Trim", amount: 1399, currency: "INR", taxInclusive: true, active: true },
    { id: "price_blr_training", cityId: "blr", serviceCode: "dog_training", packageCode: "doorstep_assessment", name: "Doorstep Training Assessment", amount: 999, currency: "INR", taxInclusive: true, active: true },
    { id: "price_blr_boarding", cityId: "blr", serviceCode: "boarding", packageCode: "standard_stay", name: "Standard Home Boarding", amount: 999, currency: "INR", taxInclusive: true, active: true },
    { id: "price_blr_sitting", cityId: "blr", serviceCode: "pet_sitting", packageCode: "home_visit", name: "Pet Sitting Home Visit", amount: 799, currency: "INR", taxInclusive: true, active: true },
    { id: "price_blr_walking", cityId: "blr", serviceCode: "dog_walking", packageCode: "tracked_walk", name: "GPS Tracked Walk", amount: 399, currency: "INR", taxInclusive: true, active: true },
    { id: "price_blr_taxi", cityId: "blr", serviceCode: "pet_taxi", packageCode: "city_trip", name: "Pet Taxi City Trip", amount: 699, currency: "INR", taxInclusive: true, active: true },
    { id: "price_blr_food_200", cityId: "blr", serviceCode: "fresh_food", packageCode: "fresh_200g", name: "Fresh Dog Food 200 g", amount: 149, currency: "INR", taxInclusive: true, active: true },
    { id: "price_blr_food_500", cityId: "blr", serviceCode: "fresh_food", packageCode: "fresh_500g", name: "Fresh Dog Food 500 g", amount: 299, currency: "INR", taxInclusive: true, active: true },
];
const seedProviders = [
    { id: "pro_arjun", cityId: "blr", name: "Arjun Kumar", model: "full_time", services: ["grooming"], zones: ["blr-east"], live: true, rating: 4.8, qualityScore: 94, capacity: 1, travelBufferMinutes: 30, maxDailyJobs: 4 },
    { id: "pro_kiran", cityId: "blr", name: "Kiran S", model: "commission", services: ["grooming", "dog_training"], zones: ["blr-east", "blr-south"], live: true, rating: 4.7, qualityScore: 91, capacity: 1, travelBufferMinutes: 30, maxDailyJobs: 5 },
    { id: "pro_nisha", cityId: "blr", name: "Nisha Rao", model: "commission", services: ["dog_training"], zones: ["blr-east", "blr-south"], live: true, rating: 4.9, qualityScore: 95, capacity: 1, travelBufferMinutes: 45, maxDailyJobs: 4 },
    { id: "pro_sanjay", cityId: "blr", name: "Sanjay P", model: "full_time", services: ["grooming"], zones: ["blr-east"], live: true, rating: 4.7, qualityScore: 88, capacity: 1, travelBufferMinutes: 30, maxDailyJobs: 4 },
    { id: "pro_ramesh", cityId: "blr", name: "Ramesh P", model: "commission", services: ["dog_training"], zones: ["blr-east"], live: true, rating: 4.7, qualityScore: 89, capacity: 1, travelBufferMinutes: 45, maxDailyJobs: 4 },
    { id: "host_ananya", cityId: "blr", name: "Ananya Pet Home", model: "commission", services: ["boarding"], zones: ["blr-east"], live: true, rating: 4.9, qualityScore: 96, capacity: 4, travelBufferMinutes: 0, maxDailyJobs: 12 },
    { id: "host_sana", cityId: "blr", name: "Sana Pet Home", model: "commission", services: ["boarding"], zones: ["blr-east"], live: true, rating: 4.8, qualityScore: 92, capacity: 3, travelBufferMinutes: 0, maxDailyJobs: 10 },
    { id: "host_tara", cityId: "blr", name: "Tara Pet Home", model: "commission", services: ["boarding"], zones: ["blr-east"], live: true, rating: 4.7, qualityScore: 89, capacity: 3, travelBufferMinutes: 0, maxDailyJobs: 10 },
    { id: "sit_rohit", cityId: "blr", name: "Rohit Sitter", model: "commission", services: ["pet_sitting"], zones: ["blr-east", "blr-south"], live: true, rating: 4.8, qualityScore: 93, capacity: 2, travelBufferMinutes: 30, maxDailyJobs: 6 },
    { id: "sit_neha", cityId: "blr", name: "Neha Sitter", model: "commission", services: ["pet_sitting"], zones: ["blr-east"], live: true, rating: 4.7, qualityScore: 90, capacity: 3, travelBufferMinutes: 30, maxDailyJobs: 6 },
    { id: "sit_asha", cityId: "blr", name: "Asha Sitter", model: "commission", services: ["pet_sitting"], zones: ["blr-east"], live: true, rating: 4.6, qualityScore: 87, capacity: 4, travelBufferMinutes: 30, maxDailyJobs: 6 },
];
export class MemoryRepository {
    customers = [...seedCustomers];
    pets = [...seedPets];
    prices = [...seedPrices];
    providers = [...seedProviders];
    bookings = [];
    subscriptions = [];
    audits = [];
    availability = [];
    notifications = [];
    payments = [];
    invoices = [];
    refunds = [];
    cashCollections = [];
    earnings = [];
    payouts = [];
    preferences = [];
    otpChallenges = [];
    enrollments = [];
    tickets = [];
    async findCustomers(query, cityId) { const q = query.toLowerCase(); return this.customers.filter(c => c.cityId === cityId && `${c.name} ${c.primaryPhone}`.toLowerCase().includes(q)); }
    async getCustomer(id) { return this.customers.find(c => c.id === id) ?? null; }
    async createCustomer(customer) { this.customers.push(customer); return customer; }
    async listPets(customerId) { return this.pets.filter(p => p.customerId === customerId); }
    async getPet(id) { return this.pets.find(p => p.id === id) ?? null; }
    async createPet(pet) { this.pets.push(pet); return pet; }
    async listPrices(cityId, serviceCode) { return this.prices.filter(p => p.cityId === cityId && p.active && (!serviceCode || p.serviceCode === serviceCode)); }
    async listEligibleProviders(cityId, zoneId, serviceCode) { return this.providers.filter(p => p.cityId === cityId && p.zones.includes(zoneId) && p.services.includes(serviceCode) && p.live).sort((a, b) => b.qualityScore - a.qualityScore); }
    async getProvider(id) { return this.providers.find(p => p.id === id) ?? null; }
    async upsertAvailability(availability) { const index = this.availability.findIndex(x => x.providerId === availability.providerId && x.date === availability.date && x.zoneId === availability.zoneId); if (index >= 0)
        this.availability[index] = availability;
    else
        this.availability.push(availability); return availability; }
    async listAvailability(providerId, date) { return this.availability.filter(x => x.providerId === providerId && x.date === date); }
    async listBookings(cityId, providerId) { return this.bookings.filter(x => x.cityId === cityId && (!providerId || x.providerId === providerId)); }
    async createBooking(booking) { this.bookings.push(booking); return booking; }
    async findBookingByIdempotencyKey(key) { return this.bookings.find(b => b.idempotencyKey === key) ?? null; }
    async getBooking(id) { return this.bookings.find(b => b.id === id) ?? null; }
    async updateBooking(id, patch) { const found = await this.getBooking(id); if (!found)
        return null; Object.assign(found, patch); return found; }
    async getSubscription(id) { return this.subscriptions.find(s => s.id === id) ?? null; }
    async createSubscription(subscription) { this.subscriptions.push(subscription); return subscription; }
    async appendAudit(event) { this.audits.push(event); }
    async listAudit(entityType, entityId) { return this.audits.filter(a => a.entityType === entityType && a.entityId === entityId); }
    async enqueueNotification(event) { this.notifications.push(event); return event; }
    async listNotifications(status) { return this.notifications.filter(x => !status || x.status === status); }
    async updateNotification(id, patch) { const found = this.notifications.find(x => x.id === id); if (!found)
        return null; Object.assign(found, patch); return found; }
    async createPayment(payment) { this.payments.push(payment); return payment; }
    async getPayment(id) { return this.payments.find(x => x.id === id) ?? null; }
    async findPaymentByIdempotencyKey(key) { return this.payments.find(x => x.idempotencyKey === key) ?? null; }
    async updatePayment(id, patch) { const found = await this.getPayment(id); if (!found)
        return null; Object.assign(found, patch); return found; }
    async createInvoice(invoice) { this.invoices.push(invoice); return invoice; }
    async getInvoiceByBooking(bookingId) { return this.invoices.find(x => x.bookingId === bookingId) ?? null; }
    async createRefund(refund) { this.refunds.push(refund); return refund; }
    async listRefunds(paymentId) { return this.refunds.filter(x => !paymentId || x.paymentId === paymentId); }
    async createCashCollection(collection) { this.cashCollections.push(collection); return collection; }
    async updateCashCollection(id, patch) { const found = this.cashCollections.find(x => x.id === id); if (!found)
        return null; Object.assign(found, patch); return found; }
    async listCashCollections(cityId) { return this.cashCollections.filter(x => x.cityId === cityId); }
    async createEarning(earning) { this.earnings.push(earning); return earning; }
    async listEarnings(providerId) { return this.earnings.filter(x => !providerId || x.providerId === providerId); }
    async updateEarning(id, patch) { const found = this.earnings.find(x => x.id === id); if (!found)
        return null; Object.assign(found, patch); return found; }
    async createPayout(payout) { this.payouts.push(payout); return payout; }
    async findPayoutByIdempotencyKey(key) { return this.payouts.find(x => x.idempotencyKey === key) ?? null; }
    async listPayouts(providerId) { return this.payouts.filter(x => !providerId || x.providerId === providerId); }
    async upsertCommunicationPreference(preference) { const index = this.preferences.findIndex(x => x.customerId === preference.customerId); if (index >= 0)
        this.preferences[index] = preference;
    else
        this.preferences.push(preference); return preference; }
    async getCommunicationPreference(customerId) { return this.preferences.find(x => x.customerId === customerId) ?? null; }
    async createOtpChallenge(challenge) { this.otpChallenges.push(challenge); return challenge; }
    async getOtpChallenge(id) { return this.otpChallenges.find(x => x.id === id) ?? null; }
    async listOtpChallenges(phoneHash) { return this.otpChallenges.filter(x => x.phoneHash === phoneHash); }
    async updateOtpChallenge(id, patch) { const found = await this.getOtpChallenge(id); if (!found)
        return null; Object.assign(found, patch); return found; }
    async createEnrollment(enrollment) { this.enrollments.push(enrollment); return enrollment; }
    async listEnrollments(status) { return this.enrollments.filter(x => !status || x.status === status); }
    async updateEnrollment(id, patch) { const found = this.enrollments.find(x => x.id === id); if (!found)
        return null; Object.assign(found, patch); return found; }
    async createTicket(ticket) { this.tickets.push(ticket); return ticket; }
    async listTickets(status) { return this.tickets.filter(x => !status || x.status === status); }
    async overview(cityId) { return { customers: this.customers.filter(x => x.cityId === cityId).length, pets: this.pets.length, bookings: this.bookings.filter(x => x.cityId === cityId).length, subscriptions: this.subscriptions.filter(x => x.status === "active").length, gmv: this.bookings.filter(x => x.cityId === cityId).reduce((s, x) => s + x.totalAmount, 0) }; }
    async close() { }
}
export class MongoRepository {
    client;
    db;
    constructor(client, db) {
        this.client = client;
        this.db = db;
    }
    static async connect(uri, database) { const client = new MongoClient(uri, { maxPoolSize: 20, minPoolSize: 2, retryWrites: true }); await client.connect(); return new MongoRepository(client, client.db(database)); }
    collection(name) { return this.db.collection(name); }
    async findCustomers(query, cityId) { return this.collection("customers").find({ cityId, $or: [{ name: { $regex: query, $options: "i" } }, { primaryPhone: { $regex: query } }] }).limit(25).toArray(); }
    async getCustomer(id) { return this.collection("customers").findOne({ id }); }
    async createCustomer(customer) { await this.collection("customers").insertOne(customer); return customer; }
    async listPets(customerId) { return this.collection("pets").find({ customerId }).toArray(); }
    async getPet(id) { return this.collection("pets").findOne({ id }); }
    async createPet(pet) { await this.collection("pets").insertOne(pet); return pet; }
    async listPrices(cityId, serviceCode) { return this.collection("city_prices").find({ cityId, active: true, ...(serviceCode ? { serviceCode } : {}) }).toArray(); }
    async listEligibleProviders(cityId, zoneId, serviceCode) { return this.collection("providers").find({ cityId, zones: zoneId, services: serviceCode, live: true }).sort({ qualityScore: -1 }).toArray(); }
    async getProvider(id) { return this.collection("providers").findOne({ id }); }
    async upsertAvailability(availability) { await this.collection("provider_availability").updateOne({ providerId: availability.providerId, date: availability.date, zoneId: availability.zoneId }, { $set: availability }, { upsert: true }); return availability; }
    async listAvailability(providerId, date) { return this.collection("provider_availability").find({ providerId, date }).toArray(); }
    async listBookings(cityId, providerId) { return this.collection("bookings").find({ cityId, ...(providerId ? { providerId } : {}) }).toArray(); }
    async createBooking(booking) { await this.collection("bookings").insertOne(booking); return booking; }
    async findBookingByIdempotencyKey(idempotencyKey) { return this.collection("bookings").findOne({ idempotencyKey }); }
    async getBooking(id) { return this.collection("bookings").findOne({ id }); }
    async updateBooking(id, patch) { return this.collection("bookings").findOneAndUpdate({ id }, { $set: patch }, { returnDocument: "after" }); }
    async getSubscription(id) { return this.collection("subscriptions").findOne({ id }); }
    async createSubscription(subscription) { await this.collection("subscriptions").insertOne(subscription); return subscription; }
    async appendAudit(event) { await this.collection("audit_events").insertOne(event); }
    async listAudit(entityType, entityId) { return this.collection("audit_events").find({ entityType, entityId }).sort({ occurredAt: -1 }).toArray(); }
    async enqueueNotification(event) { await this.collection("notification_outbox").insertOne(event); return event; }
    async listNotifications(status) { return this.collection("notification_outbox").find(status ? { status } : {}).sort({ createdAt: 1 }).limit(100).toArray(); }
    async updateNotification(id, patch) { return this.collection("notification_outbox").findOneAndUpdate({ id }, { $set: patch }, { returnDocument: "after" }); }
    async createPayment(payment) { await this.collection("payments").insertOne(payment); return payment; }
    async getPayment(id) { return this.collection("payments").findOne({ id }); }
    async findPaymentByIdempotencyKey(idempotencyKey) { return this.collection("payments").findOne({ idempotencyKey }); }
    async updatePayment(id, patch) { return this.collection("payments").findOneAndUpdate({ id }, { $set: patch }, { returnDocument: "after" }); }
    async createInvoice(invoice) { await this.collection("tax_invoices").insertOne(invoice); return invoice; }
    async getInvoiceByBooking(bookingId) { return this.collection("tax_invoices").findOne({ bookingId }); }
    async createRefund(refund) { await this.collection("refunds").insertOne(refund); return refund; }
    async listRefunds(paymentId) { return this.collection("refunds").find(paymentId ? { paymentId } : {}).toArray(); }
    async createCashCollection(collection) { await this.collection("cash_collections").insertOne(collection); return collection; }
    async updateCashCollection(id, patch) { return this.collection("cash_collections").findOneAndUpdate({ id }, { $set: patch }, { returnDocument: "after" }); }
    async listCashCollections(cityId) { return this.collection("cash_collections").find({ cityId }).toArray(); }
    async createEarning(earning) { await this.collection("provider_earnings").insertOne(earning); return earning; }
    async listEarnings(providerId) { return this.collection("provider_earnings").find(providerId ? { providerId } : {}).toArray(); }
    async updateEarning(id, patch) { return this.collection("provider_earnings").findOneAndUpdate({ id }, { $set: patch }, { returnDocument: "after" }); }
    async createPayout(payout) { await this.collection("provider_payouts").insertOne(payout); return payout; }
    async findPayoutByIdempotencyKey(idempotencyKey) { return this.collection("provider_payouts").findOne({ idempotencyKey }); }
    async listPayouts(providerId) { return this.collection("provider_payouts").find(providerId ? { providerId } : {}).toArray(); }
    async upsertCommunicationPreference(preference) { await this.collection("communication_preferences").updateOne({ customerId: preference.customerId }, { $set: preference }, { upsert: true }); return preference; }
    async getCommunicationPreference(customerId) { return this.collection("communication_preferences").findOne({ customerId }); }
    async createOtpChallenge(challenge) { await this.collection("otp_challenges").insertOne(challenge); return challenge; }
    async getOtpChallenge(id) { return this.collection("otp_challenges").findOne({ id }); }
    async listOtpChallenges(phoneHash) { return this.collection("otp_challenges").find({ phoneHash }).sort({ createdAt: -1 }).limit(10).toArray(); }
    async updateOtpChallenge(id, patch) { return this.collection("otp_challenges").findOneAndUpdate({ id }, { $set: patch }, { returnDocument: "after" }); }
    async createEnrollment(enrollment) { await this.collection("automation_enrollments").insertOne(enrollment); return enrollment; }
    async listEnrollments(status) { return this.collection("automation_enrollments").find(status ? { status } : {}).toArray(); }
    async updateEnrollment(id, patch) { return this.collection("automation_enrollments").findOneAndUpdate({ id }, { $set: patch }, { returnDocument: "after" }); }
    async createTicket(ticket) { await this.collection("support_tickets").insertOne(ticket); return ticket; }
    async listTickets(status) { return this.collection("support_tickets").find(status ? { status } : {}).toArray(); }
    async overview(cityId) { const [customers, pets, bookings, subscriptions, gmv] = await Promise.all([this.collection("customers").countDocuments({ cityId }), this.collection("pets").countDocuments({}), this.collection("bookings").countDocuments({ cityId }), this.collection("subscriptions").countDocuments({ status: "active" }), this.collection("bookings").aggregate([{ $match: { cityId } }, { $group: { _id: null, total: { $sum: "$totalAmount" } } }]).next()]); return { customers, pets, bookings, subscriptions, gmv: gmv?.total ?? 0 }; }
    async close() { await this.client.close(); }
}
export async function createRepository() {
    if (process.env.DATABASE_DRIVER !== "mongodb")
        return new MemoryRepository();
    if (!process.env.MONGODB_URI)
        throw new Error("MONGODB_URI is required when DATABASE_DRIVER=mongodb");
    return MongoRepository.connect(process.env.MONGODB_URI, process.env.MONGODB_DATABASE ?? "pawspace");
}
