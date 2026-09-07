import{integer,real,sqliteTable,text,uniqueIndex,index}from"drizzle-orm/sqlite-core";

export const escrowCustodialAccounts=sqliteTable("escrow_custodial_accounts",{
 id:text("id").primaryKey(),bookingId:text("booking_id").notNull().unique(),providerId:text("provider_id").notNull(),customerId:text("customer_id"),currency:text("currency").notNull().default("INR"),custodyAmount:real("custody_amount").notNull(),heldAmount:real("held_amount").notNull(),releasedProviderAmount:real("released_provider_amount").notNull().default(0),refundedCustomerAmount:real("refunded_customer_amount").notNull().default(0),state:text("state").notNull(),environment:text("environment").notNull().default("sandbox"),liveApproved:integer("live_approved").notNull().default(0),captureEvidenceJson:text("capture_evidence_json").notNull().default("{}"),createdAt:integer("created_at").notNull(),updatedAt:integer("updated_at").notNull(),
},table=>[index("idx_escrow_accounts_state").on(table.state,table.updatedAt)]);

export const escrowHolds=sqliteTable("escrow_holds",{
 id:text("id").primaryKey(),custodialAccountId:text("custodial_account_id").notNull(),bookingId:text("booking_id").notNull(),paymentReference:text("payment_reference"),amount:real("amount").notNull(),currency:text("currency").notNull().default("INR"),state:text("state").notNull().default("HELD"),sourceReference:text("source_reference").notNull(),idempotencyKey:text("idempotency_key").notNull().unique(),heldAt:integer("held_at").notNull(),releasedAt:integer("released_at"),updatedAt:integer("updated_at").notNull(),
});

export const disputeFreezes=sqliteTable("dispute_freezes",{
 id:text("id").primaryKey(),custodialAccountId:text("custodial_account_id").notNull(),bookingId:text("booking_id").notNull(),disputeReference:text("dispute_reference").notNull().unique(),amountFrozen:real("amount_frozen").notNull(),reason:text("reason").notNull(),evidenceJson:text("evidence_json").notNull().default("{}"),status:text("status").notNull().default("OPEN"),resolution:text("resolution"),openedBy:text("opened_by").notNull(),openedAt:integer("opened_at").notNull(),resolvedBy:text("resolved_by"),resolvedAt:integer("resolved_at"),updatedAt:integer("updated_at").notNull(),
},table=>[index("idx_dispute_freezes_booking").on(table.bookingId,table.status,table.updatedAt)]);

export const escrowLedgerTransactions=sqliteTable("escrow_ledger_transactions",{
 id:text("id").primaryKey(),custodialAccountId:text("custodial_account_id").notNull(),bookingId:text("booking_id").notNull(),eventType:text("event_type").notNull(),amount:real("amount").notNull(),providerAmount:real("provider_amount").notNull().default(0),customerAmount:real("customer_amount").notNull().default(0),stateFrom:text("state_from"),stateTo:text("state_to").notNull(),actorId:text("actor_id").notNull(),reason:text("reason").notNull(),idempotencyKey:text("idempotency_key").notNull().unique(),journalGroup:text("journal_group"),createdAt:integer("created_at").notNull(),
},table=>[index("idx_escrow_ledger_booking").on(table.bookingId,table.createdAt)]);

export const leadIntakeAdAttribution=sqliteTable("lead_intake_ad_attribution",{
 id:text("id").primaryKey(),contactId:text("contact_id").notNull().unique(),leadId:text("lead_id").notNull().unique(),sourcePlatform:text("source_platform").notNull(),gclid:text("gclid"),fbclid:text("fbclid"),wbraid:text("wbraid"),clickId:text("click_id"),utmSource:text("utm_source"),utmMedium:text("utm_medium"),utmCampaign:text("utm_campaign"),campaignId:text("campaign_id"),adId:text("ad_id"),landingUrl:text("landing_url"),metadataJson:text("metadata_json").notNull().default("{}"),createdAt:integer("created_at").notNull(),updatedAt:integer("updated_at").notNull(),
},table=>[index("idx_lead_intake_ad_campaign").on(table.sourcePlatform,table.campaignId,table.adId,table.createdAt)]);

export const whatsappLeadAttributionIntake=sqliteTable("whatsapp_lead_attribution_intake",{
 id:text("id").primaryKey(),sourcePlatform:text("source_platform").notNull(),sourceEventId:text("source_event_id").notNull(),leadId:text("lead_id").notNull(),customerId:text("customer_id").notNull(),campaignId:text("campaign_id"),adId:text("ad_id"),formId:text("form_id"),clickId:text("click_id"),gclid:text("gclid"),fbclid:text("fbclid"),wbraid:text("wbraid"),utmSource:text("utm_source"),utmMedium:text("utm_medium"),utmCampaign:text("utm_campaign"),landingUrl:text("landing_url"),metadataJson:text("metadata_json").notNull().default("{}"),createdAt:integer("created_at").notNull(),updatedAt:integer("updated_at").notNull(),
},table=>[uniqueIndex("ux_whatsapp_lead_attribution_intake_source").on(table.sourcePlatform,table.sourceEventId),index("whatsapp_lead_attribution_intake_link_idx").on(table.leadId,table.customerId,table.createdAt)]);
