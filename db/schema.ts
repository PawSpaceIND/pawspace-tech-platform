import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const crmContacts = sqliteTable("crm_contacts", {
  id: text("id").primaryKey(), name: text("name").notNull(), primaryPhone: text("primary_phone").notNull(), secondaryPhone: text("secondary_phone"), email: text("email"), area: text("area"), petNames: text("pet_names"), petSummary: text("pet_summary"), stage: text("stage").notNull().default("New lead"), owner: text("owner").default("Unassigned"), source: text("source").default("Website"), lifetimeValue: real("lifetime_value").default(0), nextAction: text("next_action"), opportunity: text("opportunity"), createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
});
export const crmActivities = sqliteTable("crm_activities", { id: text("id").primaryKey(), contactId: text("contact_id").notNull(), type: text("type").notNull(), title: text("title").notNull(), detail: text("detail"), createdAt: integer("created_at").notNull() });
export const crmTasks = sqliteTable("crm_tasks", { id: text("id").primaryKey(), contactId: text("contact_id"), title: text("title").notNull(), owner: text("owner").notNull(), dueAt: integer("due_at"), priority: text("priority").default("Normal"), status: text("status").default("Open"), createdAt: integer("created_at").notNull() });
export const crmAutomations = sqliteTable("crm_automations", { id: text("id").primaryKey(), name: text("name").notNull(), triggerName: text("trigger_name").notNull(), actionName: text("action_name").notNull(), enabled: integer("enabled", { mode: "boolean" }).default(true), runs: integer("runs").default(0), updatedAt: integer("updated_at").notNull() });

export const appUsers = sqliteTable("app_users", {
  id: text("id").primaryKey(), email: text("email").notNull().unique(), name: text("name").notNull(), roleCode: text("role_code").notNull(), status: text("status").notNull().default("active"), createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
});
export const roleDefinitions = sqliteTable("role_definitions", {
  code: text("code").primaryKey(), name: text("name").notNull(), description: text("description").notNull(), permissionsJson: text("permissions_json").notNull(), systemRole: integer("system_role", { mode: "boolean" }).notNull().default(false), updatedAt: integer("updated_at").notNull(),
});
export const securityAuditEvents = sqliteTable("security_audit_events", {
  id:text("id").primaryKey(), actorEmail:text("actor_email").notNull(), actorRole:text("actor_role").notNull(), action:text("action").notNull(), resourceType:text("resource_type").notNull(), resourceId:text("resource_id"), outcome:text("outcome").notNull(), detailJson:text("detail_json").notNull().default("{}"), createdAt:integer("created_at").notNull(),
});
export const subscriptionCustomers = sqliteTable("subscription_customers", {
  customerKey: text("customer_key").primaryKey(), customerName: text("customer_name").notNull(), primaryPhone: text("primary_phone"), secondaryPhone: text("secondary_phone"), segment: text("segment").notNull(), outboundPriority: text("outbound_priority").notNull(), nextBestAction: text("next_best_action").notNull(), firstServiceDate: text("first_service_date").notNull(), lastServiceDate: text("last_service_date").notNull(), daysSinceLastService: integer("days_since_last_service").notNull(), dormancyBucket: text("dormancy_bucket").notNull(), orders: integer("orders").notNull(), grossSales: real("gross_sales").notNull(), aov: real("aov").notNull(), servicesUsed: text("services_used").notNull(), primaryService: text("primary_service").notNull(), groomingOrders: integer("grooming_orders").notNull(), groomingSubscriptionOrders: integer("grooming_subscription_orders").notNull(), trainingOrders: integer("training_orders").notNull(), boardingOrders: integer("boarding_orders").notNull(), petSittingOrders: integer("pet_sitting_orders").notNull(), subscriptionTargetScore: real("subscription_target_score").notNull(), importBatchId: text("import_batch_id").notNull(), updatedAt: integer("updated_at").notNull(),
});
export const dataImportBatches = sqliteTable("data_import_batches", {
  id: text("id").primaryKey(), fileName: text("file_name").notNull(), rowCount: integer("row_count").notNull(), importedCount: integer("imported_count").notNull(), rejectedCount: integer("rejected_count").notNull(), status: text("status").notNull(), importedBy: text("imported_by").notNull(), createdAt: integer("created_at").notNull(),
});
export const communicationAttempts = sqliteTable("communication_attempts", {
  id: text("id").primaryKey(), customerKey: text("customer_key").notNull(), bookingId: text("booking_id"), actorEmail: text("actor_email").notNull(), channel: text("channel").notNull(), target: text("target").notNull(), outcome: text("outcome").notNull(), provider: text("provider").notNull(), providerReference: text("provider_reference"), createdAt: integer("created_at").notNull(),
});
export const groomingSubscriptions = sqliteTable("grooming_subscriptions", {
  id:text("id").primaryKey(), customerKey:text("customer_key").notNull(), petIdsJson:text("pet_ids_json").notNull(), planCode:text("plan_code").notNull(), status:text("status").notNull(), sessionsTotal:integer("sessions_total").notNull(), sessionsUsed:integer("sessions_used").notNull().default(0), startsAt:integer("starts_at").notNull(), renewsAt:integer("renews_at").notNull(), cadenceDays:integer("cadence_days").notNull().default(15), autoRenew:integer("auto_renew",{mode:"boolean"}).notNull().default(false), createdAt:integer("created_at").notNull(), updatedAt:integer("updated_at").notNull(),
});
export const subscriptionEvents = sqliteTable("subscription_events", {
  id:text("id").primaryKey(), subscriptionId:text("subscription_id").notNull(), eventType:text("event_type").notNull(), channel:text("channel"), status:text("status").notNull(), detailJson:text("detail_json").notNull().default("{}"), scheduledAt:integer("scheduled_at"), createdAt:integer("created_at").notNull(),
});
export const subscriptionAutomationRules = sqliteTable("subscription_automation_rules", {
  id:text("id").primaryKey(), name:text("name").notNull(), triggerCode:text("trigger_code").notNull(), offsetsJson:text("offsets_json").notNull(), channelsJson:text("channels_json").notNull(), botCallEnabled:integer("bot_call_enabled",{mode:"boolean"}).notNull().default(false), quietHoursStart:text("quiet_hours_start").notNull().default("20:00"), quietHoursEnd:text("quiet_hours_end").notNull().default("09:00"), active:integer("active",{mode:"boolean"}).notNull().default(true), updatedAt:integer("updated_at").notNull(),
});

export const schedulingAvailability = sqliteTable("scheduling_availability", {
  id:text("id").primaryKey(), providerId:text("provider_id").notNull(), cityId:text("city_id").notNull(), zoneId:text("zone_id").notNull(), date:text("date").notNull(), windowsJson:text("windows_json").notNull(), source:text("source").notNull(), updatedAt:integer("updated_at").notNull(),
});
export const schedulingReservations = sqliteTable("scheduling_reservations", {
  id:text("id").primaryKey(), groupId:text("group_id").notNull(), providerId:text("provider_id").notNull(), serviceCode:text("service_code").notNull(), cityId:text("city_id").notNull(), zoneId:text("zone_id").notNull(), customerId:text("customer_id").notNull(), petIdsJson:text("pet_ids_json").notNull(), scheduledStart:text("scheduled_start").notNull(), scheduledEnd:text("scheduled_end").notNull(), capacityUnits:integer("capacity_units").notNull().default(1), occurrenceNumber:integer("occurrence_number").notNull().default(1), careMode:text("care_mode"), status:text("status").notNull().default("assigned"), explanationJson:text("explanation_json").notNull(), createdAt:integer("created_at").notNull(),
});
export const schedulingRules = sqliteTable("scheduling_rules", {
  id:text("id").primaryKey(), name:text("name").notNull(), serviceCode:text("service_code"), cityId:text("city_id"), zoneId:text("zone_id"), priority:integer("priority").notNull().default(100), conditionJson:text("condition_json").notNull(), active:integer("active",{mode:"boolean"}).notNull().default(true), createdBy:text("created_by").notNull(), createdAt:integer("created_at").notNull(), updatedAt:integer("updated_at").notNull(),
});
export const schedulingAssignmentDecisions = sqliteTable("scheduling_assignment_decisions", {
  groupId:text("group_id").primaryKey(), strategy:text("strategy").notNull(), shortlistJson:text("shortlist_json").notNull(), selectedProviderId:text("selected_provider_id"), status:text("status").notNull(), actorId:text("actor_id"), reason:text("reason"), updatedAt:integer("updated_at").notNull(),
});

export const servicePackages = sqliteTable("service_packages", {
  id:text("id").primaryKey(), serviceCode:text("service_code").notNull(), packageCode:text("package_code").notNull().unique(), name:text("name").notNull(), description:text("description").notNull(), basePrice:real("base_price").notNull(), currency:text("currency").notNull().default("INR"), taxInclusive:integer("tax_inclusive",{mode:"boolean"}).notNull().default(true), slotMinutes:integer("slot_minutes").notNull(), blockingMinutes:integer("blocking_minutes").notNull(), active:integer("active",{mode:"boolean"}).notNull().default(true), version:integer("version").notNull().default(1), effectiveFrom:text("effective_from").notNull(), effectiveTo:text("effective_to"), updatedBy:text("updated_by").notNull(), updatedAt:integer("updated_at").notNull(),
});
export const dynamicPricingRules = sqliteTable("dynamic_pricing_rules", {
  id:text("id").primaryKey(), name:text("name").notNull(), serviceCode:text("service_code").notNull(), packageCode:text("package_code"), cityId:text("city_id").notNull().default("blr"), zoneId:text("zone_id"), ruleType:text("rule_type").notNull(), daysJson:text("days_json").notNull().default("[]"), startTime:text("start_time"), endTime:text("end_time"), effectiveFrom:text("effective_from").notNull(), effectiveTo:text("effective_to"), adjustmentType:text("adjustment_type").notNull(), adjustmentValue:real("adjustment_value").notNull(), couponPolicy:text("coupon_policy").notNull().default("stackable"), priority:integer("priority").notNull().default(100), status:text("status").notNull().default("draft"), version:integer("version").notNull().default(1), updatedBy:text("updated_by").notNull(), updatedAt:integer("updated_at").notNull(),
});
export const pricingAuditEvents = sqliteTable("pricing_audit_events", {
  id:text("id").primaryKey(), entityType:text("entity_type").notNull(), entityId:text("entity_id").notNull(), action:text("action").notNull(), beforeJson:text("before_json"), afterJson:text("after_json").notNull(), actorId:text("actor_id").notNull(), reason:text("reason").notNull(), createdAt:integer("created_at").notNull(),
});

export const businessMetricDefinitions = sqliteTable("business_metric_definitions", {
  code: text("code").primaryKey(), name: text("name").notNull(), description: text("description").notNull(), formulaJson: text("formula_json").notNull(), sourceTablesJson: text("source_tables_json").notNull(), ownerRole: text("owner_role").notNull(), version: integer("version").notNull().default(1), active: integer("active", { mode: "boolean" }).notNull().default(true), updatedAt: integer("updated_at").notNull(),
});
export const reportDefinitions = sqliteTable("report_definitions", {
  id: text("id").primaryKey(), name: text("name").notNull(), category: text("category").notNull(), metricsJson: text("metrics_json").notNull(), dimensionsJson: text("dimensions_json").notNull(), filtersJson: text("filters_json").notNull(), formatsJson: text("formats_json").notNull(), scheduleJson: text("schedule_json"), recipientRulesJson: text("recipient_rules_json"), active: integer("active", { mode: "boolean" }).notNull().default(true), createdBy: text("created_by").notNull(), updatedAt: integer("updated_at").notNull(),
});
export const reportRuns = sqliteTable("report_runs", {
  id: text("id").primaryKey(), reportId: text("report_id").notNull(), status: text("status").notNull(), format: text("format").notNull(), rowCount: integer("row_count").notNull().default(0), snapshotAt: integer("snapshot_at").notNull(), requestedBy: text("requested_by").notNull(), purpose: text("purpose").notNull(), masked: integer("masked", { mode: "boolean" }).notNull().default(true), outputReference: text("output_reference"), createdAt: integer("created_at").notNull(),
});

export const marketingCampaigns = sqliteTable("marketing_campaigns", {
  id: text("id").primaryKey(), name: text("name").notNull(), platform: text("platform").notNull(), objective: text("objective").notNull(), vertical: text("vertical").notNull(), city: text("city").notNull(), audience: text("audience").notNull(), dailyBudget: real("daily_budget").notNull(), startDate: text("start_date").notNull(), endDate: text("end_date"), status: text("status").notNull().default("draft"), utmJson: text("utm_json").notNull(), attributionJson: text("attribution_json").notNull(), createdBy: text("created_by").notNull(), createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
});
export const marketingPromotions = sqliteTable("marketing_promotions", {
  id: text("id").primaryKey(), name: text("name").notNull(), promotionType: text("promotion_type").notNull(), vertical: text("vertical").notNull(), audience: text("audience").notNull(), value: real("value").notNull(), budgetCap: real("budget_cap").notNull(), holdoutPercent: integer("holdout_percent").notNull().default(10), couponPolicy: text("coupon_policy").notNull(), startAt: text("start_at").notNull(), endAt: text("end_at").notNull(), status: text("status").notNull().default("draft"), createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
});
export const marketingAutomationRules = sqliteTable("marketing_automation_rules", {
  id: text("id").primaryKey(), name: text("name").notNull(), triggerCode: text("trigger_code").notNull(), conditionJson: text("condition_json").notNull(), actionJson: text("action_json").notNull(), approvalMode: text("approval_mode").notNull().default("human_approval"), enabled: integer("enabled", { mode: "boolean" }).notNull().default(false), lastRunAt: integer("last_run_at"), updatedAt: integer("updated_at").notNull(),
});
export const marketingAuditEvents = sqliteTable("marketing_audit_events", {
  id: text("id").primaryKey(), entityType: text("entity_type").notNull(), entityId: text("entity_id").notNull(), action: text("action").notNull(), detailJson: text("detail_json").notNull(), actorId: text("actor_id").notNull(), createdAt: integer("created_at").notNull(),
});

export const financeExpenses = sqliteTable("finance_expenses", {
  id:text("id").primaryKey(), expenseDate:text("expense_date").notNull(), claimant:text("claimant").notNull(), merchant:text("merchant").notNull(), category:text("category").notNull(), costCentre:text("cost_centre").notNull(), vertical:text("vertical").notNull(), amount:real("amount").notNull(), gstAmount:real("gst_amount").notNull().default(0), paymentMode:text("payment_mode").notNull(), receiptReference:text("receipt_reference"), status:text("status").notNull().default("submitted"), duplicateRisk:integer("duplicate_risk",{mode:"boolean"}).notNull().default(false), createdAt:integer("created_at").notNull(), updatedAt:integer("updated_at").notNull(),
});
export const financeVendors = sqliteTable("finance_vendors", {
  id:text("id").primaryKey(), name:text("name").notNull(), gstin:text("gstin"), pan:text("pan"), paymentTermsDays:integer("payment_terms_days").notNull().default(30), bankReference:text("bank_reference"), tdsSection:text("tds_section"), status:text("status").notNull().default("active"), createdAt:integer("created_at").notNull(), updatedAt:integer("updated_at").notNull(),
});
export const financeBills = sqliteTable("finance_bills", {
  id:text("id").primaryKey(), vendorId:text("vendor_id").notNull(), billNumber:text("bill_number").notNull(), billDate:text("bill_date").notNull(), dueDate:text("due_date").notNull(), costCentre:text("cost_centre").notNull(), vertical:text("vertical").notNull(), taxableAmount:real("taxable_amount").notNull(), gstAmount:real("gst_amount").notNull(), tdsAmount:real("tds_amount").notNull().default(0), totalAmount:real("total_amount").notNull(), status:text("status").notNull().default("draft"), purchaseOrderId:text("purchase_order_id"), attachmentReference:text("attachment_reference"), createdAt:integer("created_at").notNull(), updatedAt:integer("updated_at").notNull(),
});
export const financeJournalEntries = sqliteTable("finance_journal_entries", {
  id:text("id").primaryKey(), entryDate:text("entry_date").notNull(), sourceType:text("source_type").notNull(), sourceId:text("source_id").notNull(), accountCode:text("account_code").notNull(), costCentre:text("cost_centre"), vertical:text("vertical"), debit:real("debit").notNull().default(0), credit:real("credit").notNull().default(0), narration:text("narration").notNull(), periodCode:text("period_code").notNull(), posted:integer("posted",{mode:"boolean"}).notNull().default(false), createdAt:integer("created_at").notNull(),
});
export const financeBankTransactions = sqliteTable("finance_bank_transactions", {
  id:text("id").primaryKey(), bankAccount:text("bank_account").notNull(), transactionDate:text("transaction_date").notNull(), reference:text("reference").notNull(), description:text("description").notNull(), amount:real("amount").notNull(), matchType:text("match_type"), matchedSourceId:text("matched_source_id"), status:text("status").notNull().default("unmatched"), createdAt:integer("created_at").notNull(), updatedAt:integer("updated_at").notNull(),
});
export const financeBudgets = sqliteTable("finance_budgets", {
  id:text("id").primaryKey(), periodCode:text("period_code").notNull(), costCentre:text("cost_centre").notNull(), vertical:text("vertical").notNull(), category:text("category").notNull(), budgetAmount:real("budget_amount").notNull(), alertThreshold:real("alert_threshold").notNull().default(90), approvedBy:text("approved_by"), createdAt:integer("created_at").notNull(), updatedAt:integer("updated_at").notNull(),
});
export const financeClosePeriods = sqliteTable("finance_close_periods", {
  periodCode:text("period_code").primaryKey(), status:text("status").notNull().default("open"), checklistJson:text("checklist_json").notNull(), lockedAt:integer("locked_at"), lockedBy:text("locked_by"), updatedAt:integer("updated_at").notNull(),
});
export const financeAuditEvents = sqliteTable("finance_audit_events", {
  id:text("id").primaryKey(), entityType:text("entity_type").notNull(), entityId:text("entity_id").notNull(), action:text("action").notNull(), beforeJson:text("before_json"), afterJson:text("after_json").notNull(), actorId:text("actor_id").notNull(), reason:text("reason").notNull(), createdAt:integer("created_at").notNull(),
});

export const launchReadinessItems = sqliteTable("launch_readiness_items", {
  code:text("code").primaryKey(), module:text("module").notNull(), title:text("title").notNull(), priority:text("priority").notNull(), launchStage:text("launch_stage").notNull(), ownerRole:text("owner_role").notNull(), status:text("status").notNull().default("not_started"), dependencyType:text("dependency_type").notNull().default("internal"), acceptanceCriteria:text("acceptance_criteria").notNull(), evidence:text("evidence"), blockerReason:text("blocker_reason"), targetDate:text("target_date"), updatedBy:text("updated_by").notNull(), updatedAt:integer("updated_at").notNull(),
});
export const launchUatSignoffs = sqliteTable("launch_uat_signoffs", {
  id:text("id").primaryKey(), journeyCode:text("journey_code").notNull(), testCase:text("test_case").notNull(), device:text("device").notNull(), result:text("result").notNull(), evidenceReference:text("evidence_reference"), defectReference:text("defect_reference"), signedBy:text("signed_by").notNull(), signedAt:integer("signed_at").notNull(),
});
export const operationalExceptions = sqliteTable("operational_exceptions", {
  id:text("id").primaryKey(), module:text("module").notNull(), severity:text("severity").notNull(), title:text("title").notNull(), detail:text("detail").notNull(), bookingId:text("booking_id"), ownerRole:text("owner_role").notNull(), status:text("status").notNull().default("open"), resolution:text("resolution"), createdBy:text("created_by").notNull(), createdAt:integer("created_at").notNull(), resolvedBy:text("resolved_by"), resolvedAt:integer("resolved_at"),
});
export const launchAuditEvents = sqliteTable("launch_audit_events", {
  id:text("id").primaryKey(), entityType:text("entity_type").notNull(), entityId:text("entity_id").notNull(), action:text("action").notNull(), detailJson:text("detail_json").notNull(), actorEmail:text("actor_email").notNull(), createdAt:integer("created_at").notNull(),
});

export const canonicalCustomers = sqliteTable("canonical_customers", {
  id:text("id").primaryKey(), cityId:text("city_id").notNull(), name:text("name").notNull(), primaryPhone:text("primary_phone").notNull(), secondaryPhone:text("secondary_phone"), email:text("email"), source:text("source").notNull().default("uat_customer_app"), consentJson:text("consent_json").notNull().default("{}"), createdAt:integer("created_at").notNull(), updatedAt:integer("updated_at").notNull(),
});
export const canonicalPets = sqliteTable("canonical_pets", {
  id:text("id").primaryKey(), customerId:text("customer_id").notNull(), name:text("name").notNull(), species:text("species").notNull(), breed:text("breed"), vaccinationStatus:text("vaccination_status").notNull().default("not_provided"), sourcePetId:text("source_pet_id"), createdAt:integer("created_at").notNull(), updatedAt:integer("updated_at").notNull(),
});
export const canonicalBookings = sqliteTable("canonical_bookings", {
  id:text("id").primaryKey(), idempotencyKey:text("idempotency_key").notNull().unique(), customerId:text("customer_id").notNull(), petIdsJson:text("pet_ids_json").notNull(), sourcePetIdsJson:text("source_pet_ids_json").notNull(), cityId:text("city_id").notNull(), zoneId:text("zone_id").notNull(), serviceCode:text("service_code").notNull(), packageCode:text("package_code").notNull(), packageName:text("package_name").notNull(), scheduleGroupId:text("schedule_group_id").notNull().unique(), providerId:text("provider_id").notNull(), scheduledStart:text("scheduled_start").notNull(), scheduledEnd:text("scheduled_end").notNull(), status:text("status").notNull().default("confirmed"), channel:text("channel").notNull().default("customer_app"), totalAmount:real("total_amount").notNull(), currency:text("currency").notNull().default("INR"), pricingJson:text("pricing_json").notNull().default("{}"), createdBy:text("created_by").notNull(), createdAt:integer("created_at").notNull(), updatedAt:integer("updated_at").notNull(),
});
export const providerWorkOrders = sqliteTable("provider_work_orders", {
  id:text("id").primaryKey(), bookingId:text("booking_id").notNull().unique(), scheduleGroupId:text("schedule_group_id").notNull(), providerId:text("provider_id").notNull(), providerName:text("provider_name").notNull(), providerModel:text("provider_model").notNull(), serviceCode:text("service_code").notNull(), scheduledStart:text("scheduled_start").notNull(), scheduledEnd:text("scheduled_end").notNull(), occurrenceCount:integer("occurrence_count").notNull().default(1), status:text("status").notNull().default("assigned"), assignmentJson:text("assignment_json").notNull().default("{}"), createdAt:integer("created_at").notNull(), updatedAt:integer("updated_at").notNull(),
});
export const bookingPayments = sqliteTable("booking_payments", {
  id:text("id").primaryKey(), bookingId:text("booking_id").notNull().unique(), customerId:text("customer_id").notNull(), amount:real("amount").notNull(), amountDueNow:real("amount_due_now").notNull(), currency:text("currency").notNull().default("INR"), method:text("method").notNull(), mode:text("mode").notNull(), status:text("status").notNull(), gateway:text("gateway").notNull().default("uat_sandbox"), idempotencyKey:text("idempotency_key").notNull().unique(), detailJson:text("detail_json").notNull().default("{}"), createdAt:integer("created_at").notNull(), updatedAt:integer("updated_at").notNull(),
});
export const bookingLifecycleEvents = sqliteTable("booking_lifecycle_events", {
  id:text("id").primaryKey(), bookingId:text("booking_id").notNull(), eventType:text("event_type").notNull(), entityType:text("entity_type").notNull(), entityId:text("entity_id").notNull(), actorId:text("actor_id").notNull(), detailJson:text("detail_json").notNull().default("{}"), occurredAt:integer("occurred_at").notNull(),
});
export const bookingOperationalEvents = sqliteTable("booking_operational_events", {
  id:text("id").primaryKey(), bookingId:text("booking_id").notNull(), providerId:text("provider_id").notNull(), eventType:text("event_type").notNull(), reason:text("reason").notNull(), impactMinutes:integer("impact_minutes").notNull().default(0), detailJson:text("detail_json").notNull().default("{}"), actorId:text("actor_id").notNull(), createdAt:integer("created_at").notNull(),
});
export const bookingCustomerNotifications = sqliteTable("booking_customer_notifications", {
  id:text("id").primaryKey(), bookingId:text("booking_id").notNull(), customerId:text("customer_id"), channel:text("channel").notNull(), templateCode:text("template_code").notNull(), message:text("message").notNull(), status:text("status").notNull().default("queued"), eventId:text("event_id").notNull(), createdAt:integer("created_at").notNull(),
});
export const bookingRebookingCases = sqliteTable("booking_rebooking_cases", {
  id:text("id").primaryKey(), bookingId:text("booking_id").notNull(), sourceEventId:text("source_event_id").notNull(), status:text("status").notNull().default("offered"), reason:text("reason").notNull(), eligibleAt:integer("eligible_at").notNull(), selectedStart:text("selected_start"), assignedProviderId:text("assigned_provider_id"), createdAt:integer("created_at").notNull(), updatedAt:integer("updated_at").notNull(),
});
export const bookingRefundCases = sqliteTable("booking_refund_cases", {
  id:text("id").primaryKey(), bookingId:text("booking_id").notNull(), paymentId:text("payment_id"), amount:real("amount").notNull().default(0), reason:text("reason").notNull(), status:text("status").notNull().default("requested"), requestedBy:text("requested_by").notNull(), approvedBy:text("approved_by"), gatewayReference:text("gateway_reference"), createdAt:integer("created_at").notNull(), updatedAt:integer("updated_at").notNull(),
});
export const bookingAdminActions = sqliteTable("booking_admin_actions", {
  id:text("id").primaryKey(), bookingId:text("booking_id").notNull(), action:text("action").notNull(), reason:text("reason").notNull(), detailJson:text("detail_json").notNull().default("{}"), actorEmail:text("actor_email").notNull(), createdAt:integer("created_at").notNull(),
});

export const revenueOpportunities = sqliteTable("revenue_opportunities", {
  id:text("id").primaryKey(), opportunityDate:text("opportunity_date").notNull(), customerId:text("customer_id").notNull(), leadId:text("lead_id"), bookingId:text("booking_id"), opportunityType:text("opportunity_type").notNull(), reason:text("reason").notNull(), score:integer("score").notNull(), rank:integer("rank").notNull(), expectedRevenue:real("expected_revenue").notNull(), marginPercent:real("margin_percent").notNull(), suggestedOffer:text("suggested_offer").notNull(), preferredChannel:text("preferred_channel").notNull(), owner:text("owner").notNull(), status:text("status").notNull().default("ready"), dueAt:integer("due_at").notNull(), signalsJson:text("signals_json").notNull().default("{}"), createdAt:integer("created_at").notNull(), updatedAt:integer("updated_at").notNull(),
});
export const leadWorkItems = sqliteTable("lead_work_items", {
  id:text("id").primaryKey(), customerId:text("customer_id").notNull(), source:text("source").notNull(), service:text("service").notNull(), owner:text("owner").notNull(), manager:text("manager").notNull(), status:text("status").notNull().default("active"), stage:text("stage").notNull().default("day_1"), workDay:integer("work_day").notNull().default(1), assignedAt:integer("assigned_at").notNull(), firstActionDueAt:integer("first_action_due_at").notNull(), managerAlertAt:integer("manager_alert_at").notNull(), firstActionAt:integer("first_action_at"), callAttempts:integer("call_attempts").notNull().default(0), whatsappAttempts:integer("whatsapp_attempts").notNull().default(0), lastOutcome:text("last_outcome"), nextActionAt:integer("next_action_at"), recycleAt:integer("recycle_at"), recycleCycle:integer("recycle_cycle").notNull().default(0), optOut:integer("opt_out",{mode:"boolean"}).notNull().default(false), convertedBookingId:text("converted_booking_id"), createdAt:integer("created_at").notNull(), updatedAt:integer("updated_at").notNull(),
});
export const leadAttempts = sqliteTable("lead_attempts", {
  id:text("id").primaryKey(), leadId:text("lead_id").notNull(), channel:text("channel").notNull(), sequenceNumber:integer("sequence_number").notNull(), outcome:text("outcome").notNull(), note:text("note"), providerStatus:text("provider_status").notNull().default("uat_queued"), createdBy:text("created_by").notNull(), createdAt:integer("created_at").notNull(),
});
export const customerExperienceTickets = sqliteTable("customer_experience_tickets", {
  id:text("id").primaryKey(), customerId:text("customer_id"), bookingId:text("booking_id"), leadId:text("lead_id"), category:text("category").notNull(), priority:text("priority").notNull(), subject:text("subject").notNull(), detail:text("detail").notNull(), owner:text("owner").notNull(), manager:text("manager").notNull(), slaDueAt:integer("sla_due_at").notNull(), status:text("status").notNull().default("open"), escalationLevel:integer("escalation_level").notNull().default(0), customerStatus:text("customer_status").notNull().default("We received your request"), resolution:text("resolution"), rootCause:text("root_cause"), resolutionEvidence:text("resolution_evidence"), reopenedCount:integer("reopened_count").notNull().default(0), createdBy:text("created_by").notNull(), createdAt:integer("created_at").notNull(), updatedAt:integer("updated_at").notNull(), resolvedAt:integer("resolved_at"),
});
export const crmEngineAuditEvents = sqliteTable("crm_engine_audit_events", {
  id:text("id").primaryKey(), entityType:text("entity_type").notNull(), entityId:text("entity_id").notNull(), action:text("action").notNull(), actorEmail:text("actor_email").notNull(), detailJson:text("detail_json").notNull().default("{}"), createdAt:integer("created_at").notNull(),
});
export const leadReopenEvents = sqliteTable("lead_reopen_events", {
  id:text("id").primaryKey(), leadId:text("lead_id").notNull(), cycle:integer("cycle").notNull(), reopenedAt:integer("reopened_at").notNull(), assignedOwner:text("assigned_owner").notNull(), previousStatus:text("previous_status").notNull(), outcome:text("outcome").notNull().default("reopened"), createdAt:integer("created_at").notNull(),
});
export const communicationDeliveryEvents = sqliteTable("communication_delivery_events", {
  id:text("id").primaryKey(), entityType:text("entity_type").notNull(), entityId:text("entity_id").notNull(), channel:text("channel").notNull(), provider:text("provider").notNull(), templateCode:text("template_code").notNull(), consentStatus:text("consent_status").notNull(), deliveryStatus:text("delivery_status").notNull().default("uat_queued"), providerReference:text("provider_reference"), attemptCount:integer("attempt_count").notNull().default(0), nextRetryAt:integer("next_retry_at"), detailJson:text("detail_json").notNull().default("{}"), createdAt:integer("created_at").notNull(), updatedAt:integer("updated_at").notNull(),
});
export const salesPerformanceDaily = sqliteTable("sales_performance_daily", {
  id:text("id").primaryKey(), performanceDate:text("performance_date").notNull(), employeeName:text("employee_name").notNull(), targetRevenue:real("target_revenue").notNull(), eligibleRevenue:real("eligible_revenue").notNull(), collections:real("collections").notNull(), conversions:integer("conversions").notNull(), renewals:integer("renewals").notNull(), slaPercent:real("sla_percent").notNull(), rnrPercent:real("rnr_percent").notNull(), refunds:real("refunds").notNull(), incentiveAmount:real("incentive_amount").notNull(), rank:integer("rank").notNull(), status:text("status").notNull().default("provisional"), updatedAt:integer("updated_at").notNull(),
});
export const commandReportRuns = sqliteTable("command_report_runs", {
  id:text("id").primaryKey(), reportDate:text("report_date").notNull(), periodType:text("period_type").notNull(), scheduledFor:integer("scheduled_for").notNull(), status:text("status").notNull().default("uat_queued"), metricsJson:text("metrics_json").notNull(), recipientsJson:text("recipients_json").notNull(), deliveryChannelsJson:text("delivery_channels_json").notNull(), generatedAt:integer("generated_at").notNull(),
});
export const financeDayClosures = sqliteTable("finance_day_closures", {
  closureDate:text("closure_date").primaryKey(), checklistJson:text("checklist_json").notNull(), status:text("status").notNull().default("open"), varianceAmount:real("variance_amount").notNull().default(0), note:text("note"), submittedBy:text("submitted_by"), submittedAt:integer("submitted_at"), approvedBy:text("approved_by"), approvedAt:integer("approved_at"), escalationLevel:integer("escalation_level").notNull().default(0), updatedAt:integer("updated_at").notNull(),
});
export const opsCompletionControls = sqliteTable("ops_completion_controls", {
  id:text("id").primaryKey(), bookingId:text("booking_id").notNull(), vertical:text("vertical").notNull(), owner:text("owner").notNull(), scheduledEndAt:integer("scheduled_end_at").notNull(), status:text("status").notNull().default("in_progress"), serviceEvidence:text("service_evidence"), customerUpdateAt:integer("customer_update_at"), paymentConfirmed:integer("payment_confirmed",{mode:"boolean"}).notNull().default(false), providerSettlementReady:integer("provider_settlement_ready",{mode:"boolean"}).notNull().default(false), exceptionReason:text("exception_reason"), escalationLevel:integer("escalation_level").notNull().default(0), completedAt:integer("completed_at"), updatedAt:integer("updated_at").notNull(),
});
export const systemIntegrationRuns = sqliteTable("system_integration_runs", {
  id:text("id").primaryKey(), status:text("status").notNull(), internalPassed:integer("internal_passed").notNull(), internalTotal:integer("internal_total").notNull(), externalReady:integer("external_ready").notNull(), externalTotal:integer("external_total").notNull(), snapshotJson:text("snapshot_json").notNull(), actorEmail:text("actor_email").notNull(), createdAt:integer("created_at").notNull(),
});
