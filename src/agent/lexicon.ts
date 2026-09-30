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
