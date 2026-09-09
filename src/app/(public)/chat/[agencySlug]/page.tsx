import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { CONSENT_NOTICE } from "@/agent/prompts/fallback";
import { getConfig } from "@/core/config";
import { QUESTIONS } from "@/domain/slots";
import { findAgencyBySlug } from "@/services/agency";
import ChatWidget from "./ChatWidget";

/**
 * The lead's whole application: one page, one URL per agency (FR-016).
 *
 * It resolves the tenant and nothing else. Everything the widget needs that is
 * not a message — the agency's name, the consent wording, the opening question,
 * the pulse interval it counts against — is handed down as props, because a
 * client bundle must not carry `domain/`, the prompts, or the configuration
 * schema to work them out for itself.
 *
 * The `(public)` group is deliberately outside `src/proxy.ts`'s matcher: this
 * page has no session and must never redirect to `/login`.
 */

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ agencySlug: string }>;
}): Promise<Metadata> {
  const { agencySlug } = await params;
  const agency = await findAgencyBySlug(agencySlug);
  return {
    title: agency === null ? "Atendimento" : `Atendimento · ${agency.name}`,
    description: "Fale com a gente e encontre o imóvel certo.",
  };
}

export default async function ChatPage({
  params,
}: {
  params: Promise<{ agencySlug: string }>;
}) {
  const { agencySlug } = await params;

  // FR-016: an unknown slug is a 404, never a conversation against some other
  // agency's data.
  const agency = await findAgencyBySlug(agencySlug);
  if (agency === null) notFound();

  return (
    <ChatWidget
      agencySlug={agency.slug}
      agencyName={agency.name}
      consentNotice={CONSENT_NOTICE}
      openingQuestion={QUESTIONS.intent}
      pulseIntervalMs={getConfig().SSE_PULSE_INTERVAL_MS}
    />
  );
}
