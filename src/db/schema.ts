import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * The Drizzle-shaped translation of `docs/arquitetura/modelo-de-dados.md` §1,
 * via `specs/002-data-model-seed-catalog/data-model.md` — column-for-column,
 * not a paraphrase. That document wins on any disagreement.
 *
 * One file for all nine tables: small enough to read end-to-end, and it keeps
 * cross-table enums (e.g. `leadChannel`, shared by `leads` and `conversations`)
 * from being scattered with no boundary benefit.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const userRoleEnum = pgEnum("user_role", ["broker", "salesManager"]);

export const leadChannelEnum = pgEnum("lead_channel", ["web", "telegram"]);

export const leadIntentEnum = pgEnum("lead_intent", [
  "purchase",
  "rental",
  "investment",
  "undefined",
]);

// Forward-only pipeline stage; broker may set won/lost from any stage (ADR 19).
export const leadStatusEnum = pgEnum("lead_status", [
  "new",
  "qualifying",
  "qualified",
  "scheduled",
  "visited",
  "won",
  "lost",
]);

export const conversationStatusEnum = pgEnum("conversation_status", [
  "active",
  "paused",
  "closed",
]);

export const followupStateEnum = pgEnum("followup_state", ["none", "pending", "exhausted"]);

export const actorTypeEnum = pgEnum("actor_type", ["lead", "user", "agent", "worker", "system"]);

export const messageRoleEnum = pgEnum("message_role", ["lead", "agent", "broker", "system"]);

export const propertyTypeEnum = pgEnum("property_type", [
  "apartment",
  "house",
  "commercial",
  "land",
]);

export const propertyTransactionEnum = pgEnum("property_transaction", ["sale", "rent"]);

export const appointmentTypeEnum = pgEnum("appointment_type", ["viewing", "call"]);

export const appointmentStatusEnum = pgEnum("appointment_status", [
  "proposed",
  "confirmed",
  "cancelled",
  "done",
]);

export const followupStatusEnum = pgEnum("followup_status", [
  "pending",
  "running",
  "sent",
  "cancelled",
  "failed",
]);

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export const agencies = pgTable("agencies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  // Spec 006 FR-019: automatic follow-up for the whole agency, set by a sales
  // manager. Read when an attempt is about to be sent, never when it is queued.
  followupEnabled: boolean("followup_enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique("agencies_slug_unique").on(table.slug)]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  agencyId: uuid("agency_id")
    .notNull()
    .references(() => agencies.id),
  name: text("name").notNull(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: userRoleEnum("role").notNull(),
  // Intents the broker serves (purchase/rental/investment); empty on the manager.
  specializations: jsonb("specializations")
    .$type<string[]>()
    .notNull()
    .default([]),
  // Per weekday: { mon: { enabled, start, end }, ... }.
  availability: jsonb("availability")
    .$type<Record<string, { enabled: boolean; start: string; end: string }>>()
    .notNull()
    .default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique("users_agency_email_unique").on(table.agencyId, table.email)]);

export const leads = pgTable("leads", {
  id: uuid("id").primaryKey().defaultRandom(),
  agencyId: uuid("agency_id")
    .notNull()
    .references(() => agencies.id),
  name: text("name"),
  phone: text("phone"),
  email: text("email"),
  channel: leadChannelEnum("channel").notNull(),
  externalId: text("external_id").notNull(),
  intent: leadIntentEnum("intent").notNull().default("undefined"),
  status: leadStatusEnum("status").notNull().default("new"),
  score: integer("score").notNull().default(0),
  assignedBrokerId: uuid("assigned_broker_id").references(() => users.id),
  consentAt: timestamp("consent_at", { withTimezone: true }),
  doNotContact: boolean("do_not_contact").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("leads_agency_channel_external_unique").on(
    table.agencyId,
    table.channel,
    table.externalId,
  ),
]);

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  agencyId: uuid("agency_id")
    .notNull()
    .references(() => agencies.id),
  leadId: uuid("lead_id")
    .notNull()
    .references(() => leads.id),
  channel: leadChannelEnum("channel").notNull(),
  status: conversationStatusEnum("status").notNull().default("active"),
  // Who assumed the conversation; null with `paused` = "Aguardando corretor".
  heldByUserId: uuid("held_by_user_id").references(() => users.id),
  followupState: followupStateEnum("followup_state").notNull().default("none"),
  // In-flight turn marker; guarantees one turn per conversation.
  processingSince: timestamp("processing_since", { withTimezone: true }),
  slots: jsonb("slots").$type<Record<string, unknown>>().notNull().default({}),
  summary: text("summary"),
  previewLine: text("preview_line"),
  summaryUpdatedAt: timestamp("summary_updated_at", { withTimezone: true }),
  lastLeadMessageAt: timestamp("last_lead_message_at", { withTimezone: true }),
  lastAgentMessageAt: timestamp("last_agent_message_at", { withTimezone: true }),
  fallbackStreak: integer("fallback_streak").notNull().default(0),
  followupAttempts: integer("followup_attempts").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Scoped transitively through its conversation — no agencyId column, per
  // data-model.md (FR-002 applies to the nine tables the model document lists
  // as carrying it; messages is not one of them).
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id),
  role: messageRoleEnum("role").notNull(),
  content: text("content").notNull(),
  // Agent messages only — the last lead message the turn read.
  repliesToMessageId: uuid("replies_to_message_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("messages_conversation_created_idx").on(table.conversationId, table.createdAt),
]);

export const properties = pgTable("properties", {
  id: uuid("id").primaryKey().defaultRandom(),
  agencyId: uuid("agency_id")
    .notNull()
    .references(() => agencies.id),
  code: text("code").notNull(),
  title: text("title").notNull(),
  type: propertyTypeEnum("type").notNull(),
  transaction: propertyTransactionEnum("transaction").notNull(),
  price: integer("price").notNull(),
  condoFee: integer("condo_fee"),
  areaM2: integer("area_m2").notNull(),
  bedrooms: integer("bedrooms").notNull(),
  bathrooms: integer("bathrooms").notNull(),
  parkingSpots: integer("parking_spots").notNull(),
  neighborhood: text("neighborhood").notNull(),
  city: text("city").notNull(),
  region: text("region").notNull(),
  description: text("description").notNull(),
  features: jsonb("features").$type<string[]>().notNull().default([]),
  // Only on sale rows; permits yield math for the investment script.
  estimatedRent: integer("estimated_rent"),
  imageUrl: text("image_url").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("properties_agency_code_unique").on(table.agencyId, table.code),
  index("properties_agency_transaction_idx").on(table.agencyId, table.transaction),
  index("properties_agency_neighborhood_idx").on(table.agencyId, table.neighborhood),
]);

export const appointments = pgTable("appointments", {
  id: uuid("id").primaryKey().defaultRandom(),
  agencyId: uuid("agency_id")
    .notNull()
    .references(() => agencies.id),
  leadId: uuid("lead_id")
    .notNull()
    .references(() => leads.id),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id),
  brokerId: uuid("broker_id")
    .notNull()
    .references(() => users.id),
  // Null for `call` appointments.
  propertyId: uuid("property_id").references(() => properties.id),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  type: appointmentTypeEnum("type").notNull(),
  status: appointmentStatusEnum("status").notNull().default("proposed"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // Spec 006: busy intervals and the booking collision check only ever want a
  // broker's confirmed appointments.
  index("appointments_broker_busy_idx")
    .on(table.brokerId, table.scheduledAt)
    .where(sql`${table.status} = 'confirmed'`),
]);

export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  agencyId: uuid("agency_id")
    .notNull()
    .references(() => agencies.id),
  leadId: uuid("lead_id"),
  conversationId: uuid("conversation_id"),
  type: text("type").notNull(),
  actorType: actorTypeEnum("actor_type").notNull(),
  // Set iff actorType = 'user'.
  actorUserId: uuid("actor_user_id").references(() => users.id),
  // Langfuse trace id when agent/worker called the model.
  traceId: text("trace_id"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Outbox: null until a worker consumer has processed this row.
  processedAt: timestamp("processed_at", { withTimezone: true }),
}, (table) => [
  index("events_conversation_created_idx").on(table.conversationId, table.createdAt),
  // Serves the dashboard metrics (modelo-de-dados.md §4).
  index("events_agency_type_created_idx").on(table.agencyId, table.type, table.createdAt),
]);

export const followupJobs = pgTable("followup_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  agencyId: uuid("agency_id")
    .notNull()
    .references(() => agencies.id),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id),
  attempt: integer("attempt").notNull(),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
  status: followupStatusEnum("status").notNull().default("pending"),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // Serves `where status = 'pending' and scheduledFor <= now()`.
  index("followup_jobs_status_scheduled_idx").on(table.status, table.scheduledFor),
  // Spec 006: the worker's claim, over pending rows only. Largely overlaps the
  // full index above, which spec 002 created; kept because 006's data model asks
  // for it, and dropping 002's index is not this slice's decision.
  index("followup_jobs_claim_idx")
    .on(table.status, table.scheduledFor)
    .where(sql`${table.status} = 'pending'`),
]);
