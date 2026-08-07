export type Role = "customer" | "provider" | "sales" | "operations" | "finance" | "city_admin" | "super_admin" | "auditor";
export type CustomerType = "new" | "repeat" | "subscription";
export type ProviderModel = "full_time" | "commission";
export type BookingStatus = "draft" | "confirmed" | "assigned" | "on_the_way" | "arrived" | "in_service" | "completed" | "cancelled";

export interface Customer {
  id: string;
  legacyIds: string[];
  cityId: string;
  type: CustomerType;
  name: string;
  primaryPhone: string;
  secondaryPhone?: string;
  consent: { marketing: boolean; serviceUpdates: boolean; capturedAt: string };
  createdAt: string;
  updatedAt: string;
}

export interface Pet {
  id: string;
  customerId: string;
  legacyIds: string[];
  name: string;
  species: "dog" | "cat" | "other";
  breed?: string;
  birthDate?: string;
  allergies: string[];
  behaviourNotes?: string;
  vaccinationStatus: "verified" | "pending" | "expired" | "not_provided";
  createdAt: string;
  updatedAt: string;
}

export interface CityPrice {
  id: string;
  cityId: string;
  serviceCode: string;
  packageCode: string;
  name: string;
  amount: number;
  currency: "INR";
  taxInclusive: boolean;
  active: boolean;
}

export interface Provider {
  id: string;
  cityId: string;
  name: string;
  model: ProviderModel;
  services: string[];
  zones: string[];
  live: boolean;
  rating: number;
  qualityScore: number;
  capacity?: number;
  travelBufferMinutes?: number;
  maxDailyJobs?: number;
}

export interface Booking {
  id: string;
  legacyIds: string[];
  idempotencyKey: string;
  cityId: string;
  zoneId: string;
  customerId: string;
  petIds: string[];
  serviceCode: string;
  packageCode: string;
  addonCodes: string[];
  scheduledStart: string;
  scheduledEnd: string;
  status: BookingStatus;
  channel: "customer_app" | "web" | "sales_assisted" | "operations_assisted";
  totalAmount: number;
  subscriptionId?: string;
  providerId?: string;
  assignmentMode?: "automatic" | "offer";
  scheduleGroupId?: string;
  occurrenceNumber?: number;
  capacityUnits?: number;
  scheduleMode?: "single" | "recurring" | "date_range";
  careMode?: "visit" | "overnight";
  assignmentExplanation?: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface Subscription {
  id: string;
  customerId: string;
  petIds: string[];
  serviceCode: string;
  packageCode: string;
  totalSessions: 3 | 6 | 12;
  usedSessions: number;
  validityEndsAt: string;
  cadence: "every_15_days" | "customer_selects" | "reminder_only";
  status: "active" | "paused" | "expired" | "completed";
}

export interface AuditEvent {
  id: string;
  occurredAt: string;
  actorId: string;
  actorRole: Role;
  action: string;
  entityType: string;
  entityId: string;
  cityId: string;
  metadata: Record<string, unknown>;
}

export interface ProviderAvailability {
  id: string;
  providerId: string;
  cityId: string;
  zoneId: string;
  date: string;
  windows: string[];
  source: "partner_app" | "operations" | "roster";
  updatedAt: string;
}

export interface NotificationEvent {
  id: string;
  eventType: string;
  customerId?: string;
  providerId?: string;
  bookingId?: string;
  channels: Array<"push" | "whatsapp" | "sms" | "email" | "voice">;
  templateCode: string;
  payload: Record<string, unknown>;
  status: "pending" | "processing" | "sent" | "partially_sent" | "failed";
  attempts: number;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
}

export type PaymentMethod = "upi" | "card" | "netbanking" | "payment_link" | "cash";
export interface Payment {
  id: string;
  bookingId: string;
  customerId: string;
  cityId: string;
  amount: number;
  currency: "INR";
  method: PaymentMethod;
  mode: "prepaid" | "pay_after_service";
  status: "created" | "authorised" | "captured" | "failed" | "partially_refunded" | "refunded";
  gateway: "razorpay" | "cash";
  gatewayOrderId?: string;
  gatewayPaymentId?: string;
  idempotencyKey: string;
  capturedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaxInvoice {
  id: string;
  invoiceNumber: string;
  bookingId: string;
  paymentId: string;
  customerId: string;
  cityId: string;
  placeOfSupply: string;
  grossAmount: number;
  taxableAmount: number;
  cgst: number;
  sgst: number;
  igst: number;
  gstRate: 18;
  issuedAt: string;
  status: "issued" | "credit_note_issued";
}

export interface Refund {
  id: string;
  paymentId: string;
  bookingId: string;
  amount: number;
  reason: string;
  status: "requested" | "approved" | "processing" | "completed" | "failed";
  gatewayRefundId?: string;
  requestedBy: string;
  approvedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CashCollection {
  id: string;
  bookingId: string;
  paymentId: string;
  providerId: string;
  cityId: string;
  amount: number;
  collectedAt: string;
  depositedAt?: string;
  reconciledAt?: string;
  status: "collected" | "deposited" | "reconciled" | "short" | "excess";
  reconciliationNote?: string;
}

export interface ProviderEarning {
  id: string;
  bookingId: string;
  providerId: string;
  cityId: string;
  serviceValue: number;
  baseEarning: number;
  incentive: number;
  deductions: number;
  netPayable: number;
  eligibleAt: string;
  status: "cooling" | "eligible" | "held" | "scheduled" | "paid" | "reversed";
  holdReason?: string;
  payoutId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderPayout {
  id: string;
  providerId: string;
  cityId: string;
  earningIds: string[];
  amount: number;
  gateway: "razorpayx";
  gatewayPayoutId?: string;
  status: "created" | "queued" | "processing" | "paid" | "failed" | "reversed";
  idempotencyKey: string;
  scheduledAt: string;
  paidAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CommunicationPreference {
  customerId: string;
  serviceUpdates: boolean;
  reminders: boolean;
  marketing: boolean;
  channels: Array<"push" | "whatsapp" | "sms" | "email" | "voice">;
  quietHoursStart: string;
  quietHoursEnd: string;
  reminderCadence: "every_15_days" | "every_30_days" | "manual";
  updatedAt: string;
}

export interface OtpChallenge {
  id: string;
  phoneHash: string;
  purpose: "login" | "booking_confirmation" | "sensitive_action";
  codeHash: string;
  expiresAt: string;
  attempts: number;
  maxAttempts: number;
  consumedAt?: string;
  createdAt: string;
}

export interface AutomationEnrollment {
  id: string;
  customerId: string;
  journeyCode: "care_15_day" | "subscription_renewal" | "payment_recovery" | "service_recovery" | "app_adoption";
  status: "active" | "paused" | "completed" | "suppressed";
  nextRunAt: string;
  lastRunAt?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SupportTicket {
  id: string;
  customerId?: string;
  bookingId?: string;
  category: "service_recovery" | "payment" | "provider_delay" | "customer_unavailable" | "technical";
  priority: "normal" | "high" | "urgent";
  status: "open" | "assigned" | "resolved" | "closed";
  source: "automation" | "customer" | "provider" | "operations";
  summary: string;
  assignedTeam: string;
  slaDueAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface RequestActor { id: string; role: Role; cityId: string; }

export interface PlatformRepository {
  findCustomers(query: string, cityId: string): Promise<Customer[]>;
  getCustomer(id: string): Promise<Customer | null>;
  createCustomer(customer: Customer): Promise<Customer>;
  listPets(customerId: string): Promise<Pet[]>;
  getPet(id: string): Promise<Pet | null>;
  createPet(pet: Pet): Promise<Pet>;
  listPrices(cityId: string, serviceCode?: string): Promise<CityPrice[]>;
  listEligibleProviders(cityId: string, zoneId: string, serviceCode: string): Promise<Provider[]>;
  getProvider(id: string): Promise<Provider | null>;
  upsertAvailability(availability: ProviderAvailability): Promise<ProviderAvailability>;
  listAvailability(providerId: string, date: string): Promise<ProviderAvailability[]>;
  listBookings(cityId: string, providerId?: string): Promise<Booking[]>;
  createBooking(booking: Booking): Promise<Booking>;
  findBookingByIdempotencyKey(key: string): Promise<Booking | null>;
  getBooking(id: string): Promise<Booking | null>;
  updateBooking(id: string, patch: Partial<Booking>): Promise<Booking | null>;
  getSubscription(id: string): Promise<Subscription | null>;
  createSubscription(subscription: Subscription): Promise<Subscription>;
  appendAudit(event: AuditEvent): Promise<void>;
  listAudit(entityType: string, entityId: string): Promise<AuditEvent[]>;
  enqueueNotification(event: NotificationEvent): Promise<NotificationEvent>;
  listNotifications(status?: NotificationEvent["status"]): Promise<NotificationEvent[]>;
  updateNotification(id: string, patch: Partial<NotificationEvent>): Promise<NotificationEvent | null>;
  createPayment(payment: Payment): Promise<Payment>;
  getPayment(id: string): Promise<Payment | null>;
  findPaymentByIdempotencyKey(key: string): Promise<Payment | null>;
  updatePayment(id: string, patch: Partial<Payment>): Promise<Payment | null>;
  createInvoice(invoice: TaxInvoice): Promise<TaxInvoice>;
  getInvoiceByBooking(bookingId: string): Promise<TaxInvoice | null>;
  createRefund(refund: Refund): Promise<Refund>;
  listRefunds(paymentId?: string): Promise<Refund[]>;
  createCashCollection(collection: CashCollection): Promise<CashCollection>;
  updateCashCollection(id: string, patch: Partial<CashCollection>): Promise<CashCollection | null>;
  listCashCollections(cityId: string): Promise<CashCollection[]>;
  createEarning(earning: ProviderEarning): Promise<ProviderEarning>;
  listEarnings(providerId?: string): Promise<ProviderEarning[]>;
  updateEarning(id: string, patch: Partial<ProviderEarning>): Promise<ProviderEarning | null>;
  createPayout(payout: ProviderPayout): Promise<ProviderPayout>;
  findPayoutByIdempotencyKey(key: string): Promise<ProviderPayout | null>;
  listPayouts(providerId?: string): Promise<ProviderPayout[]>;
  upsertCommunicationPreference(preference: CommunicationPreference): Promise<CommunicationPreference>;
  getCommunicationPreference(customerId: string): Promise<CommunicationPreference | null>;
  createOtpChallenge(challenge: OtpChallenge): Promise<OtpChallenge>;
  getOtpChallenge(id: string): Promise<OtpChallenge | null>;
  listOtpChallenges(phoneHash: string): Promise<OtpChallenge[]>;
  updateOtpChallenge(id: string, patch: Partial<OtpChallenge>): Promise<OtpChallenge | null>;
  createEnrollment(enrollment: AutomationEnrollment): Promise<AutomationEnrollment>;
  listEnrollments(status?: AutomationEnrollment["status"]): Promise<AutomationEnrollment[]>;
  updateEnrollment(id: string, patch: Partial<AutomationEnrollment>): Promise<AutomationEnrollment | null>;
  createTicket(ticket: SupportTicket): Promise<SupportTicket>;
  listTickets(status?: SupportTicket["status"]): Promise<SupportTicket[]>;
  overview(cityId: string): Promise<Record<string, number>>;
  close(): Promise<void>;
}
