ALTER TABLE "posts" ADD COLUMN "publish_attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "publish_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "sent_copies_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD COLUMN "health" jsonb;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "enrichment" jsonb;--> statement-breakpoint
ALTER TABLE "research_briefs" ADD COLUMN "gaps" jsonb;