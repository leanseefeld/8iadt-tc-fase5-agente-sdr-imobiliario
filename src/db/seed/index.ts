import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { getDb, closePool } from "../client.ts";
import { createLogger } from "../../core/logging.ts";
import {
  agencies,
  appointments,
  conversations,
  events,
  leads,
  messages,
  properties,
  users,
} from "../schema.ts";
import { propertyEntrySchema, validateDataset, type PropertyEntry } from "./properties.schema.ts";

/**
 * `npm run db:seed` — idempotent per FR-008. Natural-key upserts for
 * agency/users/properties (a rerun is a no-op or a refresh, never a
 * duplicate); the three demo leads use existence-check-and-skip, since a
 * conversation transcript has no natural key to upsert against
 * (research.md's "Seed idempotency strategy").
 */

const log = createLogger("app", { module: "seed" });
const db = getDb();

const BCRYPT_ROUNDS = 10;
const DEMO_PASSWORD = "demo1234";

const WORK_WEEK = {
  mon: { enabled: true, start: "09:00", end: "18:00" },
  tue: { enabled: true, start: "09:00", end: "18:00" },
  wed: { enabled: true, start: "09:00", end: "18:00" },
  thu: { enabled: true, start: "09:00", end: "18:00" },
  fri: { enabled: true, start: "09:00", end: "18:00" },
  sat: { enabled: false, start: "09:00", end: "18:00" },
  sun: { enabled: false, start: "09:00", end: "18:00" },
};

async function seedAgency(): Promise<string> {
  await db.insert(agencies).values({ name: "Imobiliária Demo", slug: "demo" }).onConflictDoNothing({
    target: agencies.slug,
  });
  const [agency] = await db.select({ id: agencies.id }).from(agencies).where(eq(agencies.slug, "demo"));
  return agency.id;
}

async function seedUsers(agencyId: string): Promise<Record<"ana" | "bruno" | "carla", string>> {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, BCRYPT_ROUNDS);

  await db
    .insert(users)
    .values([
      {
        agencyId,
        name: "Ana Ribeiro",
        email: "ana@demo.com.br",
        passwordHash,
        role: "broker",
        specializations: ["purchase", "rental"],
        availability: WORK_WEEK,
      },
      {
        agencyId,
        name: "Bruno Castro",
        email: "bruno@demo.com.br",
        passwordHash,
        role: "broker",
        specializations: ["investment", "purchase"],
        availability: WORK_WEEK,
      },
      {
        agencyId,
        name: "Carla Nunes",
        email: "carla@demo.com.br",
        passwordHash,
        role: "salesManager",
        specializations: [],
        availability: {},
      },
    ])
    .onConflictDoNothing({ target: [users.agencyId, users.email] });

  const rows = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.agencyId, agencyId));

  const byEmail = new Map(rows.map((row) => [row.email, row.id]));
  return {
    ana: byEmail.get("ana@demo.com.br")!,
    bruno: byEmail.get("bruno@demo.com.br")!,
    carla: byEmail.get("carla@demo.com.br")!,
  };
}

/** FR-012: deterministic per code, independent of whatever the dataset file carries. */
function imageUrlFor(code: string): string {
  return `https://picsum.photos/seed/${code}/640/480`;
}

function loadPropertyEntries(): PropertyEntry[] {
  const path = join(process.cwd(), "src/db/seed/properties.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `src/db/seed/properties.json is missing or not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!Array.isArray(raw)) {
    throw new Error("src/db/seed/properties.json must contain a JSON array");
  }
  if (raw.length !== 100) {
    throw new Error(`expected exactly 100 property entries, found ${raw.length}`);
  }

  const entries: PropertyEntry[] = [];
  const errors: string[] = [];
  raw.forEach((candidate, index) => {
    const result = propertyEntrySchema.safeParse(candidate);
    if (result.success) {
      entries.push(result.data);
    } else {
      errors.push(`entry ${index}: ${result.error.issues.map((issue) => issue.message).join(", ")}`);
    }
  });
  if (errors.length > 0) {
    throw new Error(`properties.json has malformed entries:\n${errors.join("\n")}`);
  }

  // FR-011's coherence rules (zone/region/price-band, ~70/30, ~15
  // commercial). Per spec.md's Out of Scope, authoring/fixing the dataset's
  // content is not this seed's job — a violation here does not block the
  // 100 rows from loading (blocking would leave every later story with no
  // demo data at all), but it must never be silent. `tests/properties-
  // dataset.test.ts` (SC-003) is the gate that actually fails the build.
  const violations = validateDataset(entries);
  if (violations.length > 0) {
    log.warn(
      { count: violations.length, violations },
      "properties.json has coherence violations against modelo-de-dados.md §5 (see SC-003) — loading anyway",
    );
  }

  return entries;
}

async function seedProperties(agencyId: string): Promise<void> {
  const entries = loadPropertyEntries();

  const rows = entries.map((entry) => ({
    agencyId,
    code: entry.code,
    title: entry.title,
    type: entry.type,
    transaction: entry.transaction,
    price: entry.price,
    condoFee: entry.condoFee,
    areaM2: entry.areaM2,
    bedrooms: entry.bedrooms,
    bathrooms: entry.bathrooms,
    parkingSpots: entry.parkingSpots,
    neighborhood: entry.neighborhood,
    city: entry.city,
    region: entry.region,
    description: entry.description,
    features: entry.features,
    estimatedRent: entry.estimatedRent,
    imageUrl: imageUrlFor(entry.code),
    isActive: entry.isActive,
  }));

  await db
    .insert(properties)
    .values(rows)
    .onConflictDoUpdate({
      target: [properties.agencyId, properties.code],
      set: {
        title: sql`excluded.title`,
        type: sql`excluded.type`,
        transaction: sql`excluded.transaction`,
        price: sql`excluded.price`,
        condoFee: sql`excluded.condo_fee`,
        areaM2: sql`excluded.area_m2`,
        bedrooms: sql`excluded.bedrooms`,
        bathrooms: sql`excluded.bathrooms`,
        parkingSpots: sql`excluded.parking_spots`,
        neighborhood: sql`excluded.neighborhood`,
        city: sql`excluded.city`,
        region: sql`excluded.region`,
        description: sql`excluded.description`,
        features: sql`excluded.features`,
        estimatedRent: sql`excluded.estimated_rent`,
        imageUrl: sql`excluded.image_url`,
        isActive: sql`excluded.is_active`,
      },
    });
}

interface SeedMessage {
  role: "lead" | "agent" | "broker" | "system";
  content: string;
  minutesAgo: number;
}

interface SeedEvent {
  type: string;
  actorType: "agent" | "system";
  minutesAgo: number;
  payload?: Record<string, unknown>;
}

interface DemoLead {
  externalId: "seed-hot" | "seed-warm" | "seed-cold";
  name: string;
  phone: string;
  email: string;
  intent: "purchase" | "rental" | "investment" | "undefined";
  status: "new" | "qualifying" | "qualified" | "scheduled" | "visited" | "won" | "lost";
  score: number;
  followupState: "none" | "pending" | "exhausted";
  slots: Record<string, unknown>;
  messages: SeedMessage[];
  events: SeedEvent[];
  appointment?: { minutesFromNow: number };
}

function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000);
}

function demoLeads(): DemoLead[] {
  return [
    {
      externalId: "seed-hot",
      name: "Camila Andrade",
      phone: "11988887777",
      email: "camila.andrade@example.com",
      intent: "purchase",
      status: "scheduled",
      score: 85,
      followupState: "none",
      slots: {
        priceMax: 900_000,
        bedrooms: 2,
        neighborhoods: ["Moema", "Vila Mariana"],
        urgency: "immediate",
        name: "Camila Andrade",
        contact: "11988887777",
      },
      messages: [
        { role: "lead", content: "Oi, queria comprar um apê de 2 quartos em Moema", minutesAgo: 180 },
        { role: "agent", content: "Legal! Até quanto você pretende investir?", minutesAgo: 179 },
        { role: "lead", content: "Até uns 900 mil", minutesAgo: 175 },
        { role: "agent", content: "Perfeito, encontrei algumas opções. Quer marcar uma visita amanhã às 15h?", minutesAgo: 60 },
        { role: "lead", content: "Pode ser sim!", minutesAgo: 55 },
      ],
      events: [
        { type: "lead.created", actorType: "system", minutesAgo: 181, payload: { channel: "web" } },
        { type: "lead.consented", actorType: "agent", minutesAgo: 180 },
        { type: "intent.identified", actorType: "agent", minutesAgo: 179, payload: { intent: "purchase" } },
        { type: "slot.filled", actorType: "agent", minutesAgo: 175, payload: { slot: "priceMax", value: 900_000 } },
        { type: "slot.filled", actorType: "agent", minutesAgo: 170, payload: { slot: "bedrooms", value: 2 } },
        { type: "slot.filled", actorType: "agent", minutesAgo: 168, payload: { slot: "neighborhoods" } },
        { type: "slot.filled", actorType: "agent", minutesAgo: 165, payload: { slot: "urgency", value: "immediate" } },
        { type: "slot.filled", actorType: "agent", minutesAgo: 162, payload: { slot: "contact" } },
        { type: "lead.qualified", actorType: "agent", minutesAgo: 161, payload: { score: 85 } },
        { type: "properties.suggested", actorType: "agent", minutesAgo: 61 },
        { type: "appointment.proposed", actorType: "agent", minutesAgo: 60 },
        { type: "appointment.confirmed", actorType: "agent", minutesAgo: 55 },
      ],
      appointment: { minutesFromNow: 60 * 24 },
    },
    {
      externalId: "seed-warm",
      name: "Rafael Souza",
      phone: "11977776666",
      email: "rafael.souza@example.com",
      intent: "purchase",
      status: "qualifying",
      score: 55,
      followupState: "none",
      slots: {
        priceMax: 650_000,
        bedrooms: 2,
      },
      messages: [
        { role: "lead", content: "Boa tarde, tô procurando apartamento pra comprar", minutesAgo: 40 },
        { role: "agent", content: "Boa tarde! Até quanto você pretende investir?", minutesAgo: 39 },
        { role: "lead", content: "Até 650 mil", minutesAgo: 35 },
        { role: "agent", content: "Entendido. Quantos quartos você precisa?", minutesAgo: 34 },
        { role: "lead", content: "2 quartos tá bom", minutesAgo: 20 },
      ],
      events: [
        { type: "lead.created", actorType: "system", minutesAgo: 41, payload: { channel: "web" } },
        { type: "lead.consented", actorType: "agent", minutesAgo: 40 },
        { type: "intent.identified", actorType: "agent", minutesAgo: 39, payload: { intent: "purchase" } },
        { type: "slot.filled", actorType: "agent", minutesAgo: 35, payload: { slot: "priceMax", value: 650_000 } },
        { type: "slot.filled", actorType: "agent", minutesAgo: 20, payload: { slot: "bedrooms", value: 2 } },
      ],
    },
    {
      externalId: "seed-cold",
      name: "Julia Martins",
      phone: "11966665555",
      email: "julia.martins@example.com",
      intent: "rental",
      status: "qualifying",
      score: 15,
      followupState: "pending",
      slots: {
        priceMax: 3_500,
      },
      messages: [
        { role: "lead", content: "Oi, procuro apê pra alugar", minutesAgo: 2 * 24 * 60 },
        { role: "agent", content: "Oi! Até quanto você pretende pagar de aluguel?", minutesAgo: 2 * 24 * 60 - 1 },
        { role: "lead", content: "Uns 3500", minutesAgo: 2 * 24 * 60 - 5 },
      ],
      events: [
        { type: "lead.created", actorType: "system", minutesAgo: 2 * 24 * 60 + 1, payload: { channel: "web" } },
        { type: "lead.consented", actorType: "agent", minutesAgo: 2 * 24 * 60 },
        { type: "intent.identified", actorType: "agent", minutesAgo: 2 * 24 * 60 - 1, payload: { intent: "rental" } },
        { type: "slot.filled", actorType: "agent", minutesAgo: 2 * 24 * 60 - 5, payload: { slot: "priceMax", value: 3_500 } },
      ],
    },
  ];
}

async function seedLeads(agencyId: string, brokerId: string): Promise<void> {
  for (const demo of demoLeads()) {
    const [existing] = await db
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.agencyId, agencyId), eq(leads.channel, "web"), eq(leads.externalId, demo.externalId)));
    if (existing) {
      log.debug({ externalId: demo.externalId }, "demo lead already seeded, skipping");
      continue;
    }

    const firstMessageAt = minutesFromNow(-demo.messages[0].minutesAgo);
    const [lead] = await db
      .insert(leads)
      .values({
        agencyId,
        name: demo.name,
        phone: demo.phone,
        email: demo.email,
        channel: "web",
        externalId: demo.externalId,
        intent: demo.intent,
        status: demo.status,
        score: demo.score,
        consentAt: firstMessageAt,
        doNotContact: false,
      })
      .returning({ id: leads.id });

    const lastMessage = demo.messages[demo.messages.length - 1];
    const lastLeadMessage = [...demo.messages].reverse().find((m) => m.role === "lead");
    const lastAgentMessage = [...demo.messages].reverse().find((m) => m.role === "agent");

    const [conversation] = await db
      .insert(conversations)
      .values({
        agencyId,
        leadId: lead.id,
        channel: "web",
        status: "active",
        followupState: demo.followupState,
        slots: demo.slots,
        lastLeadMessageAt: lastLeadMessage ? minutesFromNow(-lastLeadMessage.minutesAgo) : null,
        lastAgentMessageAt: lastAgentMessage ? minutesFromNow(-lastAgentMessage.minutesAgo) : null,
        previewLine: lastMessage.content,
      })
      .returning({ id: conversations.id });

    let previousLeadMessageId: string | null = null;
    let lastInsertedId: string | null = null;
    for (const message of demo.messages) {
      const [inserted] = await db
        .insert(messages)
        .values({
          conversationId: conversation.id,
          role: message.role,
          content: message.content,
          repliesToMessageId: message.role === "agent" ? previousLeadMessageId : null,
          createdAt: minutesFromNow(-message.minutesAgo),
        })
        .returning({ id: messages.id });
      lastInsertedId = inserted.id;
      if (message.role === "lead") previousLeadMessageId = inserted.id;
    }
    void lastInsertedId;

    for (const event of demo.events) {
      await db.insert(events).values({
        agencyId,
        leadId: lead.id,
        conversationId: conversation.id,
        type: event.type,
        actorType: event.actorType,
        actorUserId: null,
        payload: event.payload ?? {},
        createdAt: minutesFromNow(-event.minutesAgo),
      });
    }

    if (demo.appointment) {
      await db.insert(appointments).values({
        agencyId,
        leadId: lead.id,
        conversationId: conversation.id,
        brokerId,
        scheduledAt: minutesFromNow(demo.appointment.minutesFromNow),
        type: "viewing",
        status: "confirmed",
      });
    }

    log.info({ externalId: demo.externalId }, "seeded demo lead");
  }
}

async function main(): Promise<void> {
  const agencyId = await seedAgency();
  const { ana } = await seedUsers(agencyId);
  await seedProperties(agencyId);
  await seedLeads(agencyId, ana);

  const [[agencyCount], [userCount], [propertyCount], [leadCount]] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(agencies),
    db.select({ count: sql<number>`count(*)::int` }).from(users),
    db.select({ count: sql<number>`count(*)::int` }).from(properties),
    db.select({ count: sql<number>`count(*)::int` }).from(leads),
  ]);

  log.info(
    {
      agencies: agencyCount.count,
      users: userCount.count,
      properties: propertyCount.count,
      leads: leadCount.count,
    },
    "seed complete",
  );
}

main()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    log.error({ err: error instanceof Error ? error.message : String(error) }, "seed failed");
    await closePool();
    process.exit(1);
  });
