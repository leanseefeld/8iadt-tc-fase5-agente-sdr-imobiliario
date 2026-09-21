# Decisões pendentes

Registro de perguntas **ainda não respondidas**. Existe para que agentes de código
adiem em vez de improvisar.

> **Regra:** se um item aqui é relevante para a spec que você está escrevendo,
> **pare e pergunte**. Não escolha uma resposta plausível. Uma decisão tomada por
> conveniência dentro de uma spec vira requisito sem ninguém ter decidido nada.

Ao resolver um item: mova-o para a seção *Resolvidas*, registre o porquê em
[`arquitetura/adr/decisoes.md`](arquitetura/adr/decisoes.md) e cite a spec que o
resolveu.

---

## Em aberto

### 6. Roteamento multiagente — decidir **antes** da spec 006

**Pergunta:** a conversa continua sendo conduzida por uma única máquina de slots,
ou passa a ter um roteador na frente do orquestrador, que classifica o que a
mensagem está fazendo — respondendo, refinando a busca, perguntando sobre um
imóvel, agendando, ou apenas conversando — e despacha para o fluxo certo?

**Por que agora.** O modelo de slots de hoje é monotônico de propósito: um slot
preenchido nunca é sobrescrito (FR-010), a busca roda uma única vez no turno que
completa o roteiro, e `nextQuestion` sempre tem uma próxima pergunta para
empurrar. Isso descreve **qualificação**, e só. O que vem depois dela —
navegar, refinar, comparar, remarcar — não tem representação nenhuma:

- *"e na zona norte, tem algo?"* é lido como **não compreensão**. A extração lê o
  bairro corretamente, `mergeSlots` descarta porque o slot já está preenchido,
  nada foi aprendido, o agente pede desculpas por não ter entendido e o contador
  de fallback anda em direção a um handoff. Existe um escudo parcial
  (`cardsJustShown`), mas dura exatamente um turno.
- *"pode ser quinta em vez de quarta?"* é o mesmo problema com outra roupa: uma
  revisão de um fato já confirmado, que um estado write-once não sabe expressar.

**O que depende disso.** A spec 006 inteira — remarcação é revisão, e o
follow-up é composto **sem mensagem do lead em trânsito**, algo que `phrase()`
hoje não sabe fazer (está soldado a um turno com mensagens sem resposta e a um
`ReplySink`). A spec 005 depende em menor grau: o resumo para o corretor diz "o
que este lead quer", que com slots monotônicos é a primeira coisa que ele disse,
não a atual. O item 15 (RAG) só se paga se a busca puder ser repetida e refinada.
O item 16 do backlog *é* esta pergunta, em tamanho grande.

**Opções, da menor para a maior:**

1. **Só tornar os critérios revisáveis.** Separar *fatos de qualificação*
   (`intent`, `urgency`, `investorProfile`, `returnExpectation`, `name`,
   `contact`) — write-once, alimentam o score e o resumo — de *critérios de
   busca* (`priceMax`, `bedrooms`, `neighborhoods`) — revisáveis, alimentam
   `SearchCriteria`, que já existe como tipo próprio. A busca volta a rodar
   quando um critério muda. Resolve o caso do bairro sem nenhuma máquina nova.
2. **Fase na conversa.** `conversations.phase`: qualificando → navegando →
   agendando. Cada fase com a sua própria regra de "o que fazer agora"; a máquina
   de slots conduz apenas na primeira.
3. **Roteador de verdade.** O modelo classifica o que a mensagem está fazendo e o
   código despacha. Mantém o princípio V — o modelo *lê*, o código *decide* — e é
   a mesma divisão já usada para `askedForHuman`.

**Risco a evitar:** trocar isto por um laço de agente genérico. O determinismo é
a tese do projeto e o que sustenta as defesas contra manipulação e a promessa de
nunca repetir uma pergunta.

**Quem decide:** o desenvolvedor, antes de abrir a spec 006. Levantado em
16/09/2026 a partir do comportamento observado em conversa real.

**Direção dada em 20/09/2026:** não corrigir a slot machine por partes. A
alternativa a explorar é outra: o orquestrador entrega ao modelo os **tópicos que
faltam, em ordem preferida**, mais o estado conhecido, e o modelo decide o que
perguntar. Extração e resposta continuam separadas. A exploração está em
[`exploracoes/roteiro-por-topicos.md`](exploracoes/roteiro-por-topicos.md) — é
exploração, não decisão, e adotá-la exige **emendar o princípio V da
constituição**, que é marcado como inegociável.

**Evidência, 16/09/2026** (`scripts/probe-after-qualification.ts`, e4b local): o
Cenário 1 completo seguido de *"Gostei do segundo, ele tem varanda?"* e *"E na zona
norte, tem algo?"* termina em `handoff.requested {reason: fallback}` com score 100.
Depois do roteiro, `shouldProposeMeeting` volta a propor a reunião em todo turno, e
qualquer mensagem que não preenche slot conta como não compreensão. O mesmo ocorre
no meio do roteiro: *"Moema ou Vila Mariana"* depois de *"zona sul"* virou fallback.
A spec 006 não funciona sobre isto — *"pode ser sábado?"* é exatamente esse caso.

**Terceira manifestação, 21/09/2026 — agora no caminho do corretor.** Com a
consciência multi-parte no ar, uma conversa real: agente qualifica, Ana assume,
promete visita e preço, devolve. O lead responde *"e a visita de amanhã, continua
de pé?"* — que não preenche slot nenhum — e o turno conta como não compreensão;
a mensagem seguinte repete a dose e a conversa vai para handoff. Ou seja: o lead
é devolvido a um humano por ter falado sobre o que o humano acabou de combinar.

Duas coisas ficaram **deliberadamente sem correção** até esta decisão ser tomada
(escolha do desenvolvedor, 21/09/2026, pelo caminho mais barato agora):

1. Não há isenção de fallback para os turnos logo depois de uma devolução. Um
   remendo pontual esconderia o tamanho real do defeito.
2. Quando o turno é o primeiro depois da devolução **e** a mensagem não foi
   entendida, as duas instruções vão juntas no briefing e o modelo escolhe — na
   prática escolheu o pedido de desculpas, e a frase de reentrada ("Sofia aqui de
   volta") não apareceu. Quem redesenhar a máquina decide qual voz ganha.

### 8. Pesos do score, faixas e sinal do investidor — ficam com a spec do ADR 20

**Contexto.** O [ADR 20](arquitetura/adr/decisoes.md#20-the-lead-score-is-uncapped-and-compounding)
fixou as **regras** do score; os números não. Decidido em 20/09/2026 que a 005 sobe
com os scores de hoje (inclusive os da seed, que não batem com a fórmula) e que a
spec que implementar o ADR 20 — a "007" — resolve tudo isto de uma vez:

1. **Pesos exatos**, e como o orçamento faz o score passar de 100.
2. **"Quanto mais caro o imóvel, maior"** — lido como o orçamento do próprio lead
   (`priceMax` / `ticket`). Confirmar ou corrigir.
3. **Faixas de temperatura** novas, já que 100 deixou de ser teto.
4. **Piso 50** para aluguel com horizonte de ~2 meses: piso absoluto ou mínimo
   dentro da faixa quente?
5. **Sinal de interesse do investidor** — proposta do brainstorm registrada no ADR
   20 (horizonte ≤ 6 meses 1.0; capital líquido 0.8; aceite da ligação com canal e
   janela 0.6), ainda **não aceita**.
6. **Recalcular a seed** e reescrever `tests/score.test.ts`.

**Quem decide:** o desenvolvedor, ao abrir a spec 007. Registrado em 20/09/2026.

---

## Resolvidas

Decididas em **05/09/2026**, antes da escrita das specs 002 a 006. O porquê de
cada uma está no ADR indicado; a spec citada é a que transforma a decisão em
requisito.

| # | Pergunta | Decisão | ADR | Spec |
|---|---|---|---|---|
| 1 | Score do lead — fórmula, pesos, limiares, cadência, determinístico ou por modelo | **Determinístico, em `domain/`**, escala 0–100, recalculado a cada turno. Frio < 40, morno 40–69, quente ≥ 70. Pesos em [`arquitetura/modelo-de-dados.md`](arquitetura/modelo-de-dados.md) §Score. | [11](arquitetura/adr/decisoes.md#11-deterministic-lead-score) | 005 |
| 2 | Mecanismo de autenticação | **Cookie de sessão assinado, escrito à mão.** Usuários semeados com senha *hash*, dois papéis (`broker`, `salesManager`). Sem Auth.js. | [12](arquitetura/adr/decisoes.md#12-hand-rolled-signed-session-cookie) | 003 |
| 3 | Hospedagem do Langfuse na demonstração | **Self-hosted por profile do Compose**, com limites de memória somando **≤ 6 GiB**, reaproveitando o Postgres do projeto. Latência de consulta não importa; captura precisa ser rápida. | [13](arquitetura/adr/decisoes.md#13-langfuse-self-hosted-under-a-memory-cap) | 004 |
| 4 | Constantes do follow-up | Hipóteses iniciais viram padrão: janela 09:00–20:00 em `America/Sao_Paulo` fixo, 3 tentativas, intervalos crescentes. **Atraso da primeira tentativa em minutos** (não horas) para ser demonstrável, e botão "Disparar follow-up agora" na ficha do lead. | [15](arquitetura/adr/decisoes.md#15-follow-up-constants-and-the-demo-trigger) | 006 |
| 5 | Gatilho de handoff | **Dois** gatilhos determinísticos: lead pede pessoa; duas respostas seguidas sem entendimento. O terceiro (quente com contato) caiu no ADR 19 — quente com contato **propõe reunião**, o agente segue no comando. | [11](arquitetura/adr/decisoes.md#11-deterministic-lead-score), [19](arquitetura/adr/decisoes.md#19-three-state-axes-agent-owned-booking-sse-over-postgres-notifications) | 004 |
| 7 | Score: teto, pesos e interesse em imóvel | **Sem teto, sinais somam.** 100 = roteiro de compra completo com urgência imediata; orçamento maior pontua mais. Aluguel com horizonte de ~2 meses é quente com piso 50. Agendar aumenta; pedir humano não altera. Pesos exatos ficam com a spec que implementar. | [20](arquitetura/adr/decisoes.md#20-the-lead-score-is-uncapped-and-compounding) | a definir |

Decisões novas tomadas na mesma sessão, sem pergunta prévia no registro:

| Tema | Decisão | ADR |
|---|---|---|
| Multi-tenancy | `agencyId` em toda tabela de negócio desde a primeira migration; uma agência semeada | [10](arquitetura/adr/decisoes.md#10-agency-as-tenant-from-the-first-migration) |
| Padrão do orquestrador | *Tool calling* nativo do AI SDK, com a slot machine determinística injetando a próxima pergunta no prompt | [14](arquitetura/adr/decisoes.md#14-native-tool-calling-under-a-deterministic-slot-machine) |
| Modelo da demonstração | Desenvolvimento e testes de integração no oMLX local (`gemma-4-e4b-it-OptiQ-4bit`); demonstração com GPT-5 via Azure OpenAI, endpoint compatível | [16](arquitetura/adr/decisoes.md#16-local-e4b-for-development-azure-openai-for-the-demo) |
| Agrupamento do backlog | 11 fatias restantes reagrupadas em 5 specs (002–006) | [17](arquitetura/adr/decisoes.md#17-backlog-regrouped-into-five-specs) |
