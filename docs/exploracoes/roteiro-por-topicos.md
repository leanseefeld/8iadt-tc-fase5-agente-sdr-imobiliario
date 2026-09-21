# Exploração: tópicos em vez de slot machine

> **Não normativo. Isto é exploração, não decisão.** Nada aqui é requisito, e
> nenhuma spec deve citar este documento como autoridade. A decisão pendente é a
> [6](../decisoes-pendentes.md#6-roteamento-multiagente--decidir-antes-da-spec-006).
> Aberto em 20/09/2026 a pedido do desenvolvedor.

## O que está em questão

Hoje o código escolhe a próxima pergunta: `nextQuestion()` devolve o primeiro slot
vazio do roteiro e o prompt manda o modelo fazer **aquela** pergunta. O modelo só
veste a frase.

A alternativa a explorar inverte essa fronteira: o orquestrador entrega **os
tópicos que ainda faltam, em ordem preferida**, mais o estado já conhecido, e o
**modelo decide o que perguntar agora**. Extração e geração de resposta continuam
sendo chamadas separadas — compartilhando prefixo de prompt para aproveitar cache
— e as tools, quando houver, rodam entre as duas.

Ordem *preferida*, não obrigatória, é o ponto: se o lead acabou de falar de bairro,
perguntar sobre bairro é melhor que seguir a lista.

## Por que isto está sendo reaberto

A regra "o código decide o que perguntar" entrou em
[`visao-geral.md`](../arquitetura/visao-geral.md) §5 e §9 como texto gerado, não
como decisão tomada. O custo dela é medido, não hipotético
(`scripts/probe-after-qualification.ts`, modelo local e4b, 16/09/2026):

- *"Moema ou Vila Mariana"* depois de *"zona sul"* — a extração leu certo, o merge
  descartou porque o slot já estava cheio, e o agente respondeu que não entendeu.
- Terminado o roteiro, **toda** mensagem que não preenche slot vira não
  compreensão: duas seguidas e um lead com score 100 foi para handoff.
- A reunião é reproposta a cada turno, porque a condição que a dispara continua
  verdadeira.

Nenhum dos três é bug de implementação: os três são o modelo de estado dizendo que
só existe uma coisa a fazer numa conversa — preencher slots.

## O que a alternativa compra

- **Revisão sai de graça.** Mudar de ideia sobre bairro, preço ou quartos deixa de
  ser exceção; é só mais um tópico revisitado.
- **Depois da qualificação existe conversa.** Perguntar sobre um imóvel, comparar,
  remarcar — nada disso precisa de estado novo.
- **Menos maquinário.** `nextQuestion`, `upcomingSlots`, o gate de evidência e os
  remendos (`cardsJustShown`, `looksLikeSteering`) existem para compensar a
  rigidez. Alguns somem junto com ela.
- **A spec 006 fica possível.** Remarcar é revisão, e follow-up é uma mensagem sem
  mensagem do lead na frente — as duas coisas que o desenho de hoje não expressa.

## O que ela arrisca, e o teste barato de cada risco

O modelo de demonstração é 4-bit local. Os riscos são concretos:

| Risco | Verificação determinística que segura | Já existe? |
|---|---|---|
| Repetir pergunta já respondida | Registro de tópicos perguntados/respondidos; pergunta repetida é rejeitada antes de sair | Não — é o novo pedaço |
| Duas perguntas numa mensagem | `questionCount` em `reply-guards.ts` | Sim |
| Pular tópico obrigatório | O código, não o modelo, decide quando o roteiro terminou (`isQualified`) | Sim |
| Inventar valor/percentual | `unbackedFigure` | Sim |
| Sair do português, vazar sintaxe | `language`, `leakedSyntax` | Sim |

A tese do projeto continua de pé se a **saída** for verificada. O que muda é
*quem escolhe o assunto*, não quem valida o que sai.

## Comparação honesta

| | Slot machine (hoje) | Tópicos (esta exploração) | Fases (alternativa do Claude) |
|---|---|---|---|
| Quem escolhe o assunto | Código | Modelo, dentro de uma lista | Código |
| Revisão de critério | Impossível | Natural | Precisa de regra explícita |
| Depois da qualificação | Não existe | É só outro conjunto de tópicos | Fases novas (browsing, scheduling) |
| Código novo | — | Registro de tópicos + guarda de repetição | Máquina de fases, campo `act`, handlers |
| Código removido | — | `nextQuestion`, gate de evidência, remendos | Nenhum |
| Constituição | Compatível | **Exige emenda do princípio V** | Compatível |
| Risco no modelo 4-bit | Baixo (o código manda) | Médio (o modelo escolhe) | Médio (classificação de `act`) |

### A terceira opção, para registro

**Proposta pelo Claude em 16/09/2026 e ainda não revisada pelo desenvolvedor.**
Fases determinísticas derivadas do estado (`qualifying` → `browsing` →
`scheduling`), um campo `act` acrescentado à extração que já existe, e um
`PhaseHandler` por fase — que seria também a emenda por onde o item 16 do backlog
(multiagentes) entraria depois, cada agente especialista sendo um handler.

O custo dela está na tabela acima e vale dizer em voz alta: ela mantém o código
decidindo, então **não** exige emenda à constituição, mas **acrescenta**
maquinário onde a ideia dos tópicos **remove**. Se o critério for simplificar,
ela perde.

## Se esta alternativa for adotada — lista anti-drift

Adotar isto **não é** só mudar código. É mudar uma regra que está escrita em muitos
lugares, e deixar qualquer um deles para trás é criar drift.

**Primeiro, antes de qualquer código:**

- [ ] `.specify/memory/constitution.md` §V — *"Deterministic Slot Machine
      (NON-NEGOTIABLE)"*, que diz literalmente *"Deciding what to ask next is
      deterministic code. The model never chooses"*. Emendar por
      `/speckit-constitution`, com a justificativa e a data. Sem isso, toda spec
      seguinte nasce violando a constituição.

**Depois, os documentos normativos:**

- [ ] `docs/arquitetura/visao-geral.md` — §2 (caixa "Slot machine" no diagrama),
      §5 (passo 3 do fluxo síncrono), §9 (camada 1: *"a próxima pergunta vem do código"*)
- [ ] `docs/arquitetura/modelo-de-dados.md` §2 — "a slot machine pergunta o
      primeiro slot vazio dessa ordem"
- [ ] `docs/arquitetura/adr/decisoes.md` — ADR 14 (slot machine determinística por
      baixo do tool calling) e ADR 11; novo ADR registrando esta decisão
- [ ] `AGENTS.md` e `CLAUDE.md` — as menções à slot machine como não-negociável
- [ ] `specs/BACKLOG.md` — a linha da 004 e a do item 16

**E as specs que descrevem o comportamento:**

- [ ] `specs/004-conversation/` — spec, plan, tasks, quickstart, contracts
- [ ] `specs/006-scheduling-followup/` — depende diretamente (remarcação, follow-up)
- [ ] `specs/002-data-model-seed-catalog/` — menções ao roteiro

**Definição de pronto:** `grep -ril "slot machine\|máquina de slots" docs specs
AGENTS.md CLAUDE.md .specify` não devolve nenhuma linha que descreva o
comportamento antigo como atual. Código novo com documento velho é drift, e drift
neste projeto é defeito.

## Perguntas em aberto

1. O registro de tópicos é coluna nova ou deriva dos `events` (`slot.filled`,
   `conversation.turn`)? Derivar é mais simples e não migra nada.
2. Os tópicos são os slots de hoje com outro nome, ou uma lista maior que inclui
   "falar sobre um imóvel" e "marcar horário"?
3. O prefixo compartilhado entre extração e resposta traz as tools da extração
   para a chamada de resposta — o modelo veria tools que não pode chamar. Vale o
   ganho de cache medido (88% e 98% contra 25%)?
4. O que acontece quando o modelo escolhe mal duas vezes seguidas: reprovar e
   cair para a ordem preferida do código é rede de segurança suficiente?
