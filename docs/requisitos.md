# Requisitos do desafio × o que foi entregue

Cada item do enunciado ([`reference/Desafio - Agente SDR Imobiliario.md`](../reference/Desafio%20-%20Agente%20SDR%20Imobiliario.md))
com o seu estado, onde está no código, o que o verifica e uma conversa real que o mostra.

**Legenda:** ✅ atendido · 🟡 atendido em parte (o que falta está dito na linha) · ❌ não implementado.

As conversas citadas estão em [`exemplos/conversas.md`](exemplos/conversas.md): foram geradas pela aplicação
rodando de verdade, com o Gemma 4 12B local, e copiadas sem edição.

---

## 1. Objetivos do desafio

| Objetivo | Estado | Onde está | Como se verifica |
|---|---|---|---|
| Atender leads automaticamente | ✅ | Chat web em `/chat/demo`; cada mensagem dispara um turno do agente (`src/app/api/chat/route.ts` → `src/agent/turn/run.ts`). Se o turno falhar, o worker responde o que ficou sem resposta. | `tests/integration/chat-post.test.ts`, `tests/eval/turn.test.ts` |
| Conversa humanizada | ✅ | A Sofia tem persona e tom definidos em `src/agent/prompts/system.ts`: uma pergunta por mensagem, reconhece o que o lead disse antes de perguntar e se apresenta como assistente virtual (ADR 21). | `tests/reply-guards.test.ts`, `tests/conversational.test.ts`; [exemplos](exemplos/conversas.md) |
| Qualificar clientes | ✅ | Roteiro determinístico por intenção (`src/domain/slots.ts`) e score de 0 a 100 com temperatura (`src/domain/score.ts`). | `tests/slots.test.ts`, `tests/score.test.ts`, `tests/eval/scenario-*.test.ts` |
| Identificar compra, aluguel ou investimento | ✅ | Campo `intent` extraído pelo modelo e checado por evidência no texto (`src/agent/turn/extract.ts`, `EVIDENCE_WORDS` em `slots.ts`). A intenção é revisável no meio da conversa (ADR 22). | `evals/extraction.mjs` (18 casos rotulados), `tests/revision.test.ts` |
| Coletar informações relevantes | ✅ | Compra e aluguel: faixa de preço, quartos, bairros, urgência, nome e contato. Investimento: perfil, ticket, expectativa de retorno, nome e contato. | `tests/eval/scenario-purchase.test.ts`, `tests/eval/scenario-investment.test.ts` |
| Follow-up automático | ✅ | Fila `followup_jobs` no Postgres; o worker manda até 3 tentativas com intervalo crescente, só dentro da janela de horário. O texto é escrito com o contexto da conversa (`src/agent/followup-writer.ts`). | `tests/eval/followup-writer.test.ts`, `tests/integration/followup-send.test.ts`, `tests/followup-eligibility.test.ts` |
| Agendar reuniões ou visitas | ✅ | O código propõe horários reais da agenda do corretor e a Sofia só os apresenta. Também remarca, cancela e aceita mais de um compromisso (`src/services/scheduling.ts`, `src/domain/scheduling.ts`). | `tests/eval/booking.test.ts`, `tests/eval/changes.test.ts`, `tests/scheduling.test.ts` |
| Integrar com uma base simulada de imóveis | ✅ | Catálogo semeado com 100 imóveis em 13 bairros de São Paulo (67 à venda, 33 para alugar). A ferramenta `searchProperties` filtra por preço, quartos, bairro e transação. | `tests/properties-dataset.test.ts`, SC-004 em `scenario-purchase.test.ts` (todo imóvel mostrado existe e respeita o filtro) |
| Gerar resumos para corretores | ✅ | O worker resume cada conversa depois de 20 s de silêncio e grava o resumo e uma linha de prévia (`src/agent/summarizer.ts`, `src/jobs/summarize.ts`). | `tests/eval/summarizer.test.ts`, `tests/integration/summarize-claim.test.ts` |

## 2. Cenários esperados

### Exemplo 1 — Compra ("Estou procurando apartamento na zona sul")

| O agente deverá | Estado | Como |
|---|---|---|
| Entender intenção | ✅ | Quem procura imóvel sem dizer a finalidade é lido como compra; "zona sul" já preenche a região. |
| Perguntar faixa de preço | ✅ | `priceMax` |
| Perguntar quantidade de quartos | ✅ | `bedrooms` |
| Perguntar região de interesse | ✅ | `neighborhoods`, refinando "zona sul" para bairros |
| Identificar urgência | ✅ | `urgency`: `immediate`, `soon` ou `exploring`. Pesa no score. |
| Encaminhar para reunião | ✅ | Com o roteiro completo e o contato em mãos, a Sofia mostra imóveis reais e oferece horários de visita ao imóvel escolhido, ou uma ligação. O corretor é escolhido por especialização (`purchase`). |

Verificado ponta a ponta por `tests/eval/scenario-purchase.test.ts`, com as mensagens literais do enunciado.
Conversa real: [Compra](exemplos/conversas.md#1-compra).

### Exemplo 2 — Investimento ("Quero investir em imóveis para renda")

| O agente deverá | Estado | Como |
|---|---|---|
| Entender perfil investidor | ✅ | `investorProfile`: primeira aplicação ou já investe |
| Identificar ticket | ✅ | `ticket` |
| Identificar expectativa de retorno | ✅ | `returnExpectation`: renda, valorização, ambos ou indefinido |
| Direcionar para especialista | 🟡 | A ligação é marcada com um corretor cuja especialização inclui `investment` (`chooseBroker` em `src/services/scheduling.ts`). Na [conversa de exemplo](exemplos/conversas.md#2-investimento), a ligação foi para Bruno Castro, o corretor do seed especializado em investimento ([agenda](imagens/agenda.png)). O lead **não** consulta o catálogo (FR-024). **Limitação conhecida:** a frase que o lead lê diz "com alguém da nossa equipe", não "com um especialista em investimentos". O encaminhamento acontece, mas o lead não o vê. |

Verificado ponta a ponta por `tests/eval/scenario-investment.test.ts`. Conversa real:
[Investimento](exemplos/conversas.md#2-investimento).

### Exemplo 3 — Follow-up (o lead some)

| O agente deverá | Estado | Como |
|---|---|---|
| Retomar contato automaticamente | ✅ | Toda resposta da Sofia agenda uma tentativa (4 h, depois com fator de recuo, até 3 tentativas, só das 09h às 20h). Uma resposta do lead cancela a tentativa. O corretor pode antecipar pelo botão **Enviar follow-up agora**. |
| Manter contexto da conversa | ✅ | A mensagem de retomada é escrita a partir do estado da qualificação e termina na pergunta que ficou pendente (SC-006). |
| Reengajar o lead | ✅ | Quando o lead volta, o turno segue do ponto em que parou. Nada do que já foi respondido é perguntado de novo. |

Conversa real: [Follow-up](exemplos/conversas.md#3-follow-up) ([tela](imagens/chat-followup.png)).

## 3. Requisitos funcionais

| Requisito | Estado | Evidência |
|---|---|---|
| Atendimento conversacional | ✅ | Chat web com resposta em *streaming* (SSE sobre `LISTEN/NOTIFY` do Postgres), indicador de "digitando" e reconexão. `src/app/(public)/chat/`, `src/app/api/chat/` |
| Conversa natural | ✅ | O modelo escreve as frases; o código só dita **o que** perguntar. Guardas de saída barram mais de uma pergunta, resposta fora do português, sintaxe vazada e números não ditos pelo lead (`src/domain/reply-guards.ts`). |
| Fluxo humanizado | ✅ | A Sofia diz que é assistente virtual (ADR 21). Pede consentimento antes de guardar dados (LGPD), oferece um humano quando não sabe responder (spec 015) e transfere a conversa quando o lead pede um corretor. |
| Continuidade da conversa | ✅ | O histórico e o estado da qualificação ficam no Postgres. O widget retoma a conversa pelo `sessionId` guardado no navegador, e o follow-up retoma com contexto. |
| Qualificação de leads | ✅ | Roteiro por intenção, score de 0 a 100 e temperatura (frio, morno, quente), recalculados a cada turno e visíveis no painel. |
| Agendamento de reuniões | ✅ | Propor, confirmar, remarcar e cancelar, com até 3 compromissos por lead. Os horários vêm da disponibilidade de cada corretor. O painel tem uma página de **Agenda**. |
| Resumo inteligente | ✅ | Resumo para o corretor e linha de prévia na lista de leads, atualizados pelo worker. |
| Dashboard mínimo de acompanhamento | ✅ | **Leads**: lista ao vivo, filtros, busca e "Meus leads". **Indicadores**: leads recuperados, taxa de qualificação, tempo médio de 1ª resposta e visitas confirmadas. **Painel do lead**: resumo, qualificação, transcrição, linha do tempo, assumir ou devolver a conversa, transferir e mover de etapa. Mais as páginas de **Agenda** e **Catálogo**. |

## 4. Diferenciais

| Diferencial | Estado | O que existe de fato |
|---|---|---|
| Uso de RAG | ❌ | Não há recuperação semântica nem base vetorial. O catálogo é consultado por uma ferramenta estruturada (`searchProperties`), o que garante que todo imóvel citado existe, mas isso não é RAG. |
| Integração com WhatsApp | ❌ | Não implementada. A interface `ChannelAdapter` (`src/channels/types.ts`) é a costura prevista: o chat web é o único adaptador. |
| Memória conversacional | ✅ | Histórico, estado da qualificação (revisável) e resumo persistidos por conversa. O follow-up e o retorno do lead partem desse estado. |
| Multiagentes | 🟡 | Não há agentes autônomos conversando entre si. O turno usa **papéis de modelo separados**, cada um com prompt e saída próprios: leitura e extração (`turn/read.ts`, `turn/extract.ts`), resposta (`turn/speak.ts`), resumo (`summarizer.ts`) e escrita do follow-up (`followup-writer.ts`). O "especialista em investimento" (spec 011) foi cortado. |
| Voice AI | ❌ | Não implementado. |
| Integração com CRM | ❌ | Sem CRM externo. O painel próprio cobre funil, etapas, responsável e histórico. |
| Observabilidade | ✅ | Cada chamada ao modelo vai para o Langfuse (self-hosted), sem bloquear a resposta, com perfil e modelo em cada *trace* e dados pessoais mascarados (`src/core/langfuse.ts`, `src/core/security.ts`). Logs JSON (pino) e *health checks* do app e do worker. |
| Segurança | ✅ | Login com senha bcrypt e cookie de sessão assinado. Escopo por imobiliária e por corretor em toda consulta. Três defesas contra *prompt injection*: o estado decide, não o texto; detecção no texto; guardas na saída. Também: consentimento antes de qualquer dado, orçamento de mensagens por sessão, limite de tamanho e mascaramento de PII nos *traces*. Testes: `injection.test.ts`, `masking.test.ts`, `span-mask.test.ts`, `auth-*.test.ts`, `leads-scope.test.ts`. |
| Deploy em cloud | ❌ | Roda localmente com Docker Compose. O que é cloud-ready: a imagem de produção (`Dockerfile`, alvo `runner`), app sem estado, configuração só por ambiente e *health checks*. Só o modelo pode estar na nuvem: Azure OpenAI por perfil (ADR 23). |

## 5. Entregáveis

| Entregável | Onde |
|---|---|
| Repositório do projeto | este repositório, branch `main` |
| README | [`README.md`](../README.md) |
| Arquitetura da solução | [`docs/arquitetura/visao-geral.md`](arquitetura/visao-geral.md), [`turno-do-agente.md`](arquitetura/turno-do-agente.md), [`modelo-de-dados.md`](arquitetura/modelo-de-dados.md), [`adr/decisoes.md`](arquitetura/adr/decisoes.md) |
| Explicação da IA utilizada | README, seção **A IA utilizada**, e [`docs/arquitetura/turno-do-agente.md`](arquitetura/turno-do-agente.md) |
| Demonstração funcional | apresentada ao vivo pelo autor |
| Pitch técnico | apresentado pelo autor |
