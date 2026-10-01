CREATE TABLE "change_log" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"version" integer NOT NULL,
	"area" text NOT NULL,
	"target_id" text,
	"operation" text,
	"diff" jsonb NOT NULL,
	"reason" text,
	"actor" jsonb,
	"via" text,
	"proposal_id" text,
	"undone_at" timestamp with time zone,
	"undo_of" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"reason" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expected_outcome" text,
	"operation" text NOT NULL,
	"input" jsonb NOT NULL,
	"target_type" text,
	"target_id" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	"approval_id" text,
	"change_id" text,
	"error" text,
	"applied_at" timestamp with time zone,
	"review_after_days" integer DEFAULT 14 NOT NULL,
	"review_at" timestamp with time zone,
	"outcome" jsonb,
	"reviewed_at" timestamp with time zone,
	"created_by" jsonb,
	"decided_by" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_consumers" (
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"cursor" text,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_consumers_pk" PRIMARY KEY("workspace_id","name")
);
--> statement-breakpoint
CREATE TABLE "problems" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"owner" text DEFAULT 'anyone' NOT NULL,
	"title" text NOT NULL,
	"reason" text NOT NULL,
	"remedy" text NOT NULL,
	"subject_type" text,
	"subject_id" text,
	"person_id" text,
	"company_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"due_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"snoozed_until" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by" jsonb,
	"resolution" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_hint" text NOT NULL,
	"created_by" jsonb,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"person_id" text,
	"company_id" text,
	"opportunity_id" text,
	"campaign_id" text,
	"thread_id" text,
	"source" text NOT NULL,
	"external_id" text,
	"previous_external_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"matched_by" text NOT NULL,
	"qualified" boolean,
	"notes" text,
	"status_changed_at" timestamp with time zone,
	"created_by" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_facts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"person_id" text,
	"company_id" text,
	"scope" text NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"source" text NOT NULL,
	"source_ref" text,
	"observed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"replaced_by" text,
	"created_by" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "saves_sent_copies" boolean;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "origin" text DEFAULT 'engine' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "dispatch_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "reconcile_checks" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "owner" text DEFAULT 'engine' NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "owner_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD COLUMN "sample_size" integer;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD COLUMN "created_by" jsonb;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "hold_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "hold_reason" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "crm_open_deal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "crm_owner" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "crm_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "booking_ref" text;--> statement-breakpoint
ALTER TABLE "change_log" ADD CONSTRAINT "change_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_proposals" ADD CONSTRAINT "change_proposals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_consumers" ADD CONSTRAINT "event_consumers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problems" ADD CONSTRAINT "problems_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_webhooks" ADD CONSTRAINT "crm_webhooks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_facts" ADD CONSTRAINT "lead_facts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "change_log_workspace_version_uq" ON "change_log" USING btree ("workspace_id","version");--> statement-breakpoint
CREATE INDEX "change_log_workspace_target_idx" ON "change_log" USING btree ("workspace_id","area","target_id");--> statement-breakpoint
CREATE INDEX "change_proposals_workspace_status_idx" ON "change_proposals" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "change_proposals_review_idx" ON "change_proposals" USING btree ("status","review_at");--> statement-breakpoint
CREATE INDEX "problems_workspace_status_severity_idx" ON "problems" USING btree ("workspace_id","status","severity","due_at");--> statement-breakpoint
CREATE INDEX "problems_workspace_person_idx" ON "problems" USING btree ("workspace_id","person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "problems_workspace_dedupe_open_uq" ON "problems" USING btree ("workspace_id","dedupe_key") WHERE "problems"."dedupe_key" is not null and "problems"."status" <> 'resolved';--> statement-breakpoint
CREATE UNIQUE INDEX "crm_webhooks_workspace_uq" ON "crm_webhooks" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_webhooks_token_hash_uq" ON "crm_webhooks" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "meetings_workspace_source_external_uq" ON "meetings" USING btree ("workspace_id","source","external_id") WHERE "meetings"."external_id" is not null;--> statement-breakpoint
CREATE INDEX "meetings_workspace_status_start_idx" ON "meetings" USING btree ("workspace_id","status","start_at");--> statement-breakpoint
CREATE INDEX "meetings_workspace_person_idx" ON "meetings" USING btree ("workspace_id","person_id");--> statement-breakpoint
CREATE INDEX "lead_facts_workspace_person_idx" ON "lead_facts" USING btree ("workspace_id","person_id","status");--> statement-breakpoint
CREATE INDEX "lead_facts_workspace_company_idx" ON "lead_facts" USING btree ("workspace_id","company_id","status");--> statement-breakpoint
CREATE INDEX "lead_facts_workspace_source_idx" ON "lead_facts" USING btree ("workspace_id","source","source_ref");--> statement-breakpoint
CREATE INDEX "events_workspace_occurred_idx" ON "events" USING btree ("workspace_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "messages_workspace_company_idx" ON "messages" USING btree ("workspace_id","company_id");--> statement-breakpoint
CREATE INDEX "threads_workspace_last_inbound_idx" ON "threads" USING btree ("workspace_id","last_inbound_at");--> statement-breakpoint
CREATE UNIQUE INDEX "people_workspace_booking_ref_uq" ON "people" USING btree ("workspace_id","booking_ref") WHERE "people"."booking_ref" is not null;