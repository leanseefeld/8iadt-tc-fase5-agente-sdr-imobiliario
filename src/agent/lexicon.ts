/**
 * Portuguese the code reads by itself — a closed vocabulary, never a guess.
 *
 * The model reads the open-ended part of a message. What a small, fixed set of
 * words settles (a weekday, "de manhã", a bare "obrigado") is read here, so a
 * sampler's slip can't turn it into something else. Spec 009 started this with
 * `parseWhen`; spec 015 adds the acknowledgements.
 */

const THANKS = [
  "obrigado",
  "obrigada",
  "obg",
  "brigado",
  "brigada",
  "valeu",
  "vlw",
  "agradecido",
  "agradecida",
  "grato",
  "grata",
  "muito obrigado",
  "muito obrigada",
  "obrigadão",
  "brigadão",
  "tchau",
  "até mais",
  "até logo",
  "até breve",
  "falou",
];

const AGREEMENT = [
  "ok",
  "okay",
  "oki",
  "beleza",
  "blz",
  "show",
  "perfeito",
  "combinado",
  "certo",
  "tá bom",
  "ta bom",
  "tá certo",
  "fechado",
  "ótimo",
  "otimo",
  "top",
  "massa",
  "legal",
  "entendi",
  "tudo certo",
];

/** Emoji, punctuation, repeated letters and a leading "ah"/"então" don't change what was said. */
function bare(text: string): string {
  return text
    .toLowerCase()
    .replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u200d|\ufe0f/gu, " ")
    .replace(/[!.,;:?…~*()"'\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(ah|ahh|ah sim|então|entao|opa|nossa|oba)\s+/u, "")
    .replace(/\s+(então|entao|mesmo|viu|tá|ta|hein)$/u, "");
}

/**
 * Whether the words are nothing but phrases from `vocabulary`, joined by "e" or
 * by nothing ("ok obrigado", "beleza e valeu"). Greedy on the longest phrase, so
 * "muito obrigado" is one phrase, not "muito" left over.
 */
function onlyOf(text: string, vocabulary: readonly string[]): boolean {
  const words = text.split(" ").filter((word) => word !== "");
  const phrases = vocabulary.map((phrase) => phrase.split(" ")).sort((a, b) => b.length - a.length);
  let index = 0;
  let matched = 0;
  while (index < words.length) {
    if (words[index] === "e" && matched > 0) {
      index += 1;
      continue;
    }
    const phrase = phrases.find((candidate) => candidate.every((word, offset) => words[index + offset] === word));
    if (phrase === undefined) return false;
    index += phrase.length;
    matched += 1;
  }
  return matched > 0;
}

const ORDINALS: Record<string, number> = {
  primeira: 1, primeiro: 1, "1": 1, "1ª": 1, "1a": 1, um: 1, uma: 1,
  segunda: 2, segundo: 2, "2": 2, "2ª": 2, "2a": 2, dois: 2, duas: 2,
  terceira: 3, terceiro: 3, "3": 3, "3ª": 3, "3a": 3, "três": 3, tres: 3,
};

/**
 * With times on the table, "a primeira", "2", "pode ser a segunda opção" is a
 * pick among them — the whole message, nothing else in it. The model once read
 * "a primeira" as the first property card and booked nothing.
 */
export function readOptionPick(text: string): number | null {
  const said = bare(text);
  const match = said.match(
    /^(?:(?:pode ser|quero|prefiro|fico com|vou de|escolho)\s+)?(?:(?:a|o)\s+)?(?:op[çc][ãa]o\s+)?(\S+)(?:\s+(?:op[çc][ãa]o|hor[áa]rio))?(?:\s+(?:por favor|pfv|pf))?$/u,
  );
  if (match === null) return null;
  return ORDINALS[match[1]] ?? null;
}

/**
 * Spec 015: "queria ver outros imóveis", "tem mais opções?" — a request the
 * agent already answers (the criteria and what the search found), so it is
 * never something left over for the team.
 */
export function asksForMoreProperties(text: string): boolean {
  return /(?<!\p{L})(outr[oa]s|mais)\s+(im[óo]ve(?:l|is)|op[çc][õo]es|apartamentos?|casas?)(?!\p{L})/iu.test(text);
}

/**
 * Spec 015's safety net: the whole message is only thanks, or only agreement.
 * "obrigado!", "valeu 😊", "ok, obrigado", "👍". Anything more ("obrigado, e meu
 * marido vai junto") is not, and the model's reading stands.
 */
export function readAcknowledgement(text: string): "thanks" | "agree" | null {
  const raw = text.trim();
  if (raw === "") return null;
  const said = bare(raw);
  // Only emoji: a thumbs-up or a smile is agreement.
  if (said === "") return /\p{Extended_Pictographic}/u.test(raw) ? "agree" : null;
  if (onlyOf(said, THANKS)) return "thanks";
  if (onlyOf(said, [...THANKS, ...AGREEMENT])) return THANKS.some((word) => said.includes(word)) ? "thanks" : "agree";
  return null;
}

/** A yes or a no to the question just asked, from how the message starts. */
export function readYesNo(text: string): "yes" | "no" | null {
  if (/^\s*(n[ãa]o|melhor n[ãa]o|deixa)(?!\p{L})/iu.test(text)) return "no";
  if (/^\s*(sim|pode|isso|quero|claro|confirmo)(?!\p{L})/iu.test(text)) return "yes";
  return null;
}

/** "Remarcar", "mudar", "passar pra segunda", "cancelar", "desmarcar". */
export function mentionsChange(text: string): boolean {
  return /remarc|mudar|trocar|passar|cancel|desmarc/iu.test(text);
}

/** "Cancelar", "desmarcar", "não vou mais poder", "não posso mais". */
export function mentionsCancel(text: string): boolean {
  return /cancel|desmarc|n[ãa]o vou (mais )?poder|n[ãa]o posso mais/iu.test(text);
}

/** "MOE-0009", "moe 0009", "moe0009" — the code as the lead may type it. */
export function mentionsCode(text: string, code: string): boolean {
  const squash = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return squash(text).includes(squash(code));
}

/**
 * The words a refusal is about (spec 006 FR-005i): a ride, a refund, choosing
 * who attends by a personal trait. The model's `outOfScopeRequest` stands only
 * with one of them — "posso levar meu cachorro?" was refused on 07/10.
 */
export function mentionsOutOfScope(text: string): boolean {
  return /carona|transporte|uber|t[áa]xi|reembols|passage|combust[íi]vel|gasolina|g[êe]nero|mulher|homem|gay|l[ée]sbica|lgbt|queer|trans(?!\p{L})|bin[áa]ri|religi|evang[ée]lic|cat[óo]lic|crist[ãa]|negr[oa]|branc[oa]|cor da pele|apar[êe]ncia|bonit|ideolog|pol[íi]tic|esquerda|direita/iu.test(
    text,
  );
}

/** "Já marcamos, não?", "continua de pé?", "ficou agendado?" — a question about what is booked. */
export function asksAboutBooking(text: string): boolean {
  return /(?<!\p{L})(marcamos|agendamos)(?!\p{L})|(?<!\p{L})(est[áa]|t[áa]|ficou|continua)\s+(marcad|agendad|confirmad|de\s+p[ée])|(?<!\p{L})de\s+p[ée](?!\p{L})/iu.test(
    text,
  );
}

/**
 * The answer to one of the script's closed questions, read from the words the
 * question offers: "comprar, alugar ou investir?" and "você precisa se mudar em
 * breve ou ainda é uma pesquisa inicial?". "Alugar", "só olhando", "inicial"
 * answer them — the model sometimes read nothing, or read only the slot it had
 * already read before, and two such answers handed the lead off (08/10). Only
 * an unambiguous answer counts: words of two options read as nothing.
 */
export function readClosedAnswer(slot: "intent" | "urgency", text: string): string | null {
  const options: Record<string, RegExp> =
    slot === "intent"
      ? {
          rental: /alug|loca[çc][ãa]o|locar/iu,
          purchase: /compr|adquir/iu,
          investment: /invest/iu,
        }
      : {
          exploring: /olhando|pesquis|inicial|sem pressa|s[óo] vendo|curiosidade|explorando|n[ãa]o tenho pressa/iu,
          soon: /em breve|pr[óo]xim[oa]s? mes|alguns meses|uns meses|ainda esse ano|ainda este ano/iu,
          immediate: /urgente|imediat|o quanto antes|(?<!\p{L})logo(?!\p{L})|(?<!\p{L})j[áa](?!\p{L})|agora|esse m[êe]s|este m[êe]s/iu,
        };
  const said = Object.entries(options).filter(([, words]) => words.test(text));
  return said.length === 1 ? said[0][0] : null;
}

/**
 * A short reply — at most two words, or three with a number in them, and no
 * question mark — is an attempt to answer, never a matter for the team.
 * "inicial", "pelo menos 2": gpt-5.4-nano hands an answer it could not place
 * back as "what nothing captured", and the offer to have the team check it
 * made no sense (08/10). If nothing was read from it, the turn says so.
 */
export function isShortReply(text: string): boolean {
  const said = text.trim();
  if (said === "" || said.includes("?")) return false;
  const words = said.split(/\s+/).length;
  return words <= 2 || (words <= 3 && /\d/.test(said));
}
