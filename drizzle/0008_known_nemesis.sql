CREATE TABLE `finance_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`before_json` text,
	`after_json` text NOT NULL,
	`actor_id` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `finance_bank_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`bank_account` text NOT NULL,
	`transaction_date` text NOT NULL,
	`reference` text NOT NULL,
	`description` text NOT NULL,
	`amount` real NOT NULL,
	`match_type` text,
	`matched_source_id` text,
	`status` text DEFAULT 'unmatched' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `finance_bills` (
	`id` text PRIMARY KEY NOT NULL,
	`vendor_id` text NOT NULL,
	`bill_number` text NOT NULL,
	`bill_date` text NOT NULL,
	`due_date` text NOT NULL,
	`cost_centre` text NOT NULL,
	`vertical` text NOT NULL,
	`taxable_amount` real NOT NULL,
	`gst_amount` real NOT NULL,
	`tds_amount` real DEFAULT 0 NOT NULL,
	`total_amount` real NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`purchase_order_id` text,
	`attachment_reference` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `finance_budgets` (
	`id` text PRIMARY KEY NOT NULL,
	`period_code` text NOT NULL,
	`cost_centre` text NOT NULL,
	`vertical` text NOT NULL,
	`category` text NOT NULL,
	`budget_amount` real NOT NULL,
	`alert_threshold` real DEFAULT 90 NOT NULL,
	`approved_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `finance_close_periods` (
	`period_code` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`checklist_json` text NOT NULL,
	`locked_at` integer,
	`locked_by` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `finance_expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`expense_date` text NOT NULL,
	`claimant` text NOT NULL,
	`merchant` text NOT NULL,
	`category` text NOT NULL,
	`cost_centre` text NOT NULL,
	`vertical` text NOT NULL,
	`amount` real NOT NULL,
	`gst_amount` real DEFAULT 0 NOT NULL,
	`payment_mode` text NOT NULL,
	`receipt_reference` text,
	`status` text DEFAULT 'submitted' NOT NULL,
	`duplicate_risk` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `finance_journal_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_date` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`account_code` text NOT NULL,
	`cost_centre` text,
	`vertical` text,
	`debit` real DEFAULT 0 NOT NULL,
	`credit` real DEFAULT 0 NOT NULL,
	`narration` text NOT NULL,
	`period_code` text NOT NULL,
	`posted` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `finance_vendors` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`gstin` text,
	`pan` text,
	`payment_terms_days` integer DEFAULT 30 NOT NULL,
	`bank_reference` text,
	`tds_section` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
