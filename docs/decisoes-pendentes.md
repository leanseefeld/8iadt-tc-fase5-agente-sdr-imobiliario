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

### 8. Pesos do score, faixas e sinal do investidor — ficam com a spec 008

**Contexto.** O [ADR 20](arquitetura/adr/decisoes.md#20-the-lead-score-is-uncapped-and-compounding)
fixou as **regras** do score; os números não. Decidido em 20/09/2026 que a 005 sobe
com os scores de hoje (inclusive os da seed, que não batem com a fórmula) e que a
spec que implementar o ADR 20 resolve tudo isto de uma vez. Em 22/09/2026 ela
passou a ser a **008**, e não a 007: a 007 ficou com a orquestração (ADR 22), e
duas regras do ADR 20 — "agendar aumenta o score" entre elas — não têm como ser
implementadas antes de a spec 006 criar `appointments`. Os itens:

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

**Quem decide:** o desenvolvedor, ao abrir a spec 008 — depois da 006.
Registrado em 20/09/2026, renumerado em 22/09/2026.

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
| 7 | Score: teto, pesos e interesse em imóvel | **Sem teto, sinais somam.** 100 = roteiro de compra completo com urgência imediata; orçamento maior pontua mais. Aluguel com horizonte de ~2 meses é quente com piso 50. Agendar aumenta; pedir humano não altera. Pesos exatos ficam com a spec que implementar. | [20](arquitetura/adr/decisoes.md#20-the-lead-score-is-uncapped-and-compounding) | 008 |

Decisões novas tomadas na mesma sessão, sem pergunta prévia no registro:

| Tema | Decisão | ADR |
|---|---|---|
| Multi-tenancy | `agencyId` em toda tabela de negócio desde a primeira migration; uma agência semeada | [10](arquitetura/adr/decisoes.md#10-agency-as-tenant-from-the-first-migration) |
| Padrão do orquestrador | *Tool calling* nativo do AI SDK, com a slot machine determinística injetando a próxima pergunta no prompt | [14](arquitetura/adr/decisoes.md#14-native-tool-calling-under-a-deterministic-slot-machine) |
| Modelo da demonstração | Desenvolvimento e testes de integração no oMLX local (`gemma-4-e4b-it-OptiQ-4bit`); demonstração com GPT-5 via Azure OpenAI, endpoint compatível | [16](arquitetura/adr/decisoes.md#16-local-e4b-for-development-azure-openai-for-the-demo) |
| Agrupamento do backlog | 11 fatias restantes reagrupadas em 5 specs (002–006) | [17](arquitetura/adr/decisoes.md#17-backlog-regrouped-into-five-specs) |

---

### Resolvidas depois de 05/09/2026

| # | Pergunta | Decisão | ADR | Spec |
|---|---|---|---|---|
| 6 | Orquestração do agente — uma máquina de slots só, ou um roteador na frente que classifica o que a mensagem está fazendo? | **Nenhum dos dois.** Todo critério vira revisável, `intent` inclusive; as ações viram *tool calls* do modelo com ida e volta antes da resposta; o roteiro continua dizendo o que falta perguntar. O título da pendência estava errado — o que bloqueava a 006 era a orquestração, não a multiagência, que volta a ser o item 16 do backlog. | [22](arquitetura/adr/decisoes.md#22-revisable-qualification-state-and-actions-as-tool-calls) | 007 |

**O que a spec 007 herda desta pendência.** Duas coisas foram deixadas
deliberadamente sem correção em 21/09/2026, à espera desta decisão, e agora são
dela:

1. **Não há isenção de fallback nos turnos logo depois de uma devolução do
   corretor.** Um remendo pontual teria escondido o tamanho real do defeito.
2. **Quando o turno é o primeiro depois da devolução *e* a mensagem não foi
   entendida**, as duas instruções vão juntas no briefing e o modelo escolhe — na
   prática escolheu o pedido de desculpas, e a frase de reentrada ("Sofia aqui de
   volta") não apareceu. Quem redesenha a máquina decide qual voz ganha.

A exploração dos tópicos ([`exploracoes/roteiro-por-topicos.md`](exploracoes/roteiro-por-topicos.md))
**continua aberta** para depois do MVP: ela não foi rejeitada, foi adiada, e o
ADR 22 registra por quê.
