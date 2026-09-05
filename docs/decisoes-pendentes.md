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

_(vazio em 05/09/2026 — todas as perguntas do registro original foram decididas
pelo desenvolvedor em sessão de planejamento; ver abaixo)_

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
| 5 | Gatilho de handoff | Três gatilhos determinísticos: lead pede pessoa; duas respostas seguidas sem entendimento (fallback); ou **score ≥ 70 com contato informado** — que na prática coincide com o fim do roteiro e a proposta de reunião. | [11](arquitetura/adr/decisoes.md#11-deterministic-lead-score) | 005 |

Decisões novas tomadas na mesma sessão, sem pergunta prévia no registro:

| Tema | Decisão | ADR |
|---|---|---|
| Multi-tenancy | `agencyId` em toda tabela de negócio desde a primeira migration; uma agência semeada | [10](arquitetura/adr/decisoes.md#10-agency-as-tenant-from-the-first-migration) |
| Padrão do orquestrador | *Tool calling* nativo do AI SDK, com a slot machine determinística injetando a próxima pergunta no prompt | [14](arquitetura/adr/decisoes.md#14-native-tool-calling-under-a-deterministic-slot-machine) |
| Modelo da demonstração | Desenvolvimento e testes de integração no oMLX local (`gemma-4-e4b-it-OptiQ-4bit`); demonstração com GPT-5 via Azure OpenAI, endpoint compatível | [16](arquitetura/adr/decisoes.md#16-local-e4b-for-development-azure-openai-for-the-demo) |
| Agrupamento do backlog | 11 fatias restantes reagrupadas em 5 specs (002–006) | [17](arquitetura/adr/decisoes.md#17-backlog-regrouped-into-five-specs) |
