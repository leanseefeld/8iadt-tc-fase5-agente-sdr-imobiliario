import { BUDGET_REPLY, PRE_CONSENT_REPLY, TOO_LONG_REPLY } from "@/agent/prompts/fallback";
import { scheduleTurn, webChannel } from "@/channels/web";
import { InboundMessageError } from "@/channels/types";
import { chatSessionCookie, newChatSession, signChatSession } from "@/core/auth";
import { createLogger } from "@/core/logging";
import { findAgencyBySlug } from "@/services/agency";
import { loadChatHistory, recordLeadMessage, type InboundRejection } from "@/services/conversation";
import { toWireMessage } from "./wire";

/**
 * The widget's two plain HTTP calls — `contracts/chat-api.md` §2 and §3. The
 * third, the SSE stream, is `[conversationId]/events/route.ts`.
 *
 * `POST` stores and returns; it never runs a turn inside the request (FR-042).
 * That is not an optimisation, it is what makes the reply survive the tab
 * closing: the message is committed, the turn is claimed by whoever gets there
 * first, and the answer arrives on a connection that is not this one.
 *
 * Nothing here reaches past `services/` — the lint zone in `eslint.config.mjs`
 * enforces it, and `channels/web.ts` is the only thing between this file and a
 * turn.
 */

const log = createLogger("app", { module: "api/chat" });

/** FR-032/019: the three replies that cost no model call and persist nothing. */
const TEMPLATES: Record<InboundRejection, string> = {
  consent: PRE_CONSENT_REPLY,
  budget: BUDGET_REPLY,
  tooLong: TOO_LONG_REPLY,
};

function json(body: unknown, status: number, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: "corpo inválido" }, 400);
  }

  let inbound;
  try {
    inbound = webChannel.receive(raw);
  } catch (error) {
    if (error instanceof InboundMessageError) {
      return json({ error: `campo inválido: ${error.field}` }, 400);
    }
    throw error;
  }

  const result = await recordLeadMessage({
    agencySlug: inbound.agencySlug,
    channel: inbound.channel,
    externalId: inbound.externalId,
    clientMessageId: inbound.clientMessageId,
    text: inbound.text,
    consent: inbound.consent,
    receivedAt: inbound.receivedAt,
  });

  if (result.status === "unknownAgency") {
    return json({ error: "agência não encontrada" }, 404);
  }

  // 200, not an error: the lead is told why in their own language, no model was
  // called and nothing was written. A refusal is still a conversation.
  if (result.status === "rejected") {
    return json({ text: TEMPLATES[result.reason] }, 200);
  }

  // The signed session is minted here — the one moment the server has both the
  // agency and the session id from the same request that just proved a lead
  // exists behind them. The SSE stream trusts this cookie and not the id in its
  // own URL (FR-047).
  const cookie = chatSessionCookie(
    await signChatSession(
      newChatSession({ agencySlug: inbound.agencySlug, sessionId: inbound.externalId }),
    ),
  );

  // A duplicate `clientMessageId` wrote nothing (FR-035), so it must not start a
  // second turn either; a paused conversation stores the message and stays quiet
  // (FR-028).
  if (result.status === "stored" && result.conversationStatus === "active") {
    scheduleTurn(result.conversationId, result.agencyId);
  }

  log.info(
    { conversationId: result.conversationId, status: result.status },
    "lead message accepted",
  );

  return json({ conversationId: result.conversationId }, 202, { "set-cookie": cookie });
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const agencySlug = params.get("agencySlug");
  const sessionId = params.get("sessionId");

  if (!agencySlug || !sessionId) {
    return json({ error: "campo inválido: agencySlug e sessionId são obrigatórios" }, 400);
  }

  const agency = await findAgencyBySlug(agencySlug);
  if (agency === null) return json({ error: "agência não encontrada" }, 404);

  const history = await loadChatHistory({ agencySlug, externalId: sessionId });

  // A first visit is not an error and creates nothing: no lead, no conversation,
  // no row of any kind (`contracts/chat-api.md` §3).
  if (history === null) {
    return json({ conversationId: null, status: "active", consented: false, messages: [] }, 200);
  }

  // Re-minted on resume, so a lead who comes back after the cookie expired but
  // still has their `localStorage` id gets a stream again without sending
  // anything first.
  const cookie = chatSessionCookie(
    await signChatSession(newChatSession({ agencySlug, sessionId })),
  );

  return json(
    {
      conversationId: history.conversationId,
      status: history.status,
      consented: history.consented,
      messages: history.messages.map(toWireMessage),
    },
    200,
    { "set-cookie": cookie },
  );
}
