CREATE TYPE "public"."followup_kind" AS ENUM('followup', 'reminder');--> statement-breakpoint
ALTER TABLE "agencies" ADD COLUMN "followup_window_start" text DEFAULT '09:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "agencies" ADD COLUMN "followup_window_end" text DEFAULT '20:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "agencies" ADD COLUMN "followup_window_days" jsonb DEFAULT '["mon","tue","wed","thu","fri","sat","sun"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agencies" ADD COLUMN "reminders_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "agencies" ADD COLUMN "reminder_lead_minutes" integer DEFAULT 120 NOT NULL;--> statement-breakpoint
ALTER TABLE "followup_jobs" ADD COLUMN "kind" "followup_kind" DEFAULT 'followup' NOT NULL;--> statement-breakpoint
ALTER TABLE "followup_jobs" ADD COLUMN "appointment_id" uuid;--> statement-breakpoint
ALTER TABLE "followup_jobs" ADD COLUMN "bypass_window" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "followup_jobs" ADD CONSTRAINT "followup_jobs_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "followup_jobs_pending_reminder_unique" ON "followup_jobs" USING btree ("appointment_id") WHERE "followup_jobs"."status" = 'pending' and "followup_jobs"."kind" = 'reminder';--> statement-breakpoint
-- Spec 017: meetings confirmed before reminders existed get theirs, as booking would have queued it.
INSERT INTO "followup_jobs" ("agency_id", "conversation_id", "kind", "appointment_id", "attempt", "scheduled_for")
SELECT a."agency_id", a."conversation_id", 'reminder', a."id", 0, a."scheduled_at" - make_interval(mins => ag."reminder_lead_minutes")
  FROM "appointments" a
  JOIN "agencies" ag ON ag."id" = a."agency_id"
 WHERE a."status" = 'confirmed'
   AND a."scheduled_at" - make_interval(mins => ag."reminder_lead_minutes") > now();
