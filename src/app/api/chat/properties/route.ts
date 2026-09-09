import { createLogger } from "@/core/logging";
import { findAgencyBySlug } from "@/services/agency";
import { findPropertiesByIds } from "@/services/properties";
import { toWireProperty } from "../wire";

/**
 * The cards behind a reply's `propertyIds`.
 *
 * `contracts/chat-api.md` fixes what `GET /api/chat` and the SSE `message` event
 * carry, and both carry **ids** — the card is a property of the reply, not a copy
 * of the catalog embedded in every transcript. So the widget resolves those ids
 * here, once per set it has not seen, and this handler is the read that answers
 * it: a public projection of `contracts/chat-api.md` §5 and nothing else.
 *
 * Scoping is by agency slug, not by the widget session. Nothing here is personal
 * — these are the same rows `/catalogo` renders to anyone — and requiring the
 * signed cookie would mean a lead who cleared it saw a transcript with holes in
 * it where the cards used to be. `findPropertiesByIds` still scopes by agency, so
 * an id from another tenant returns nothing rather than someone else's listing.
 */

const log = createLogger("app", { module: "api/chat/properties" });

/** Three per turn (FR-024); a handful of turns' worth per request, and no more. */
const MAX_IDS = 30;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const agencySlug = params.get("agencySlug");
  const ids = (params.get("ids") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");

  if (!agencySlug) return json({ error: "campo inválido: agencySlug é obrigatório" }, 400);
  if (ids.length > MAX_IDS) return json({ error: "campo inválido: ids demais" }, 400);
  if (ids.length === 0) return json({ properties: [] }, 200);

  const agency = await findAgencyBySlug(agencySlug);
  if (agency === null) return json({ error: "agência não encontrada" }, 404);

  const found = await findPropertiesByIds(agency.id, ids);
  log.info({ asked: ids.length, found: found.length }, "chat cards resolved");

  return json({ properties: found.map(toWireProperty) }, 200);
}
