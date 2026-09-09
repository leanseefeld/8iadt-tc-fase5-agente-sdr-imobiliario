import { eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { agencies } from "../db/schema.ts";

/**
 * One query, two callers: the public chat page needs the agency's name for its
 * header and a 404 for a slug that does not exist (FR-016), and
 * `GET /api/chat` needs the same 404 before it can answer `200` with an empty
 * transcript for a session it has never seen (`contracts/chat-api.md` §3).
 *
 * It lives here rather than in `conversation.ts` because an agency is not a
 * conversation, and rather than in the page because a Server Component must not
 * reach past `services/` (constitution IV).
 */

export interface PublicAgency {
  id: string;
  slug: string;
  name: string;
}

/** `null` for an unknown slug — the caller decides that means 404. */
export async function findAgencyBySlug(slug: string): Promise<PublicAgency | null> {
  const [agency] = await getDb()
    .select({ id: agencies.id, slug: agencies.slug, name: agencies.name })
    .from(agencies)
    .where(eq(agencies.slug, slug))
    .limit(1);

  return agency ?? null;
}
