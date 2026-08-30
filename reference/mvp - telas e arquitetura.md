# Agente SDR Imobiliário — MVP: Interações, Telas e Arquitetura

Documento de desenho da versão inicial. Princípio norteador: **o mínimo que prova o produto, construído de forma que escalar não exija reescrita.**

---

## Parte 1 — Pontos de interação

Dois públicos, dois modos de interação completamente diferentes: o lead conversa, a equipe opera.

### 1.1 Lead — jornada completa

| # | Ponto de interação | Gatilho | O que acontece | Canal |
|---|---|---|---|---|
| L1 | **Entrada** | Lead clica no widget, escaneia QR do anúncio ou abre link `t.me` | Sessão criada, lead anônimo registrado | Widget / Telegram |
| L2 | **Saudação + opt-in** | Primeira mensagem | Agente se apresenta como assistente virtual e declara finalidade do uso dos dados | Chat |
| L3 | **Captura de intenção** | Lead descreve o que quer | Classificação: compra / aluguel / investimento / indefinido | Chat |
| L4 | **Qualificação (slot filling)** | Intenção identificada | Perguntas sequenciais, uma por vez, conforme roteiro da intenção | Chat |
| L5 | **Identificação** | Slots principais preenchidos | Agente pede nome e telefone/e-mail — pede tarde, depois de já ter entregado valor | Chat |
| L6 | **Apresentação de imóveis** | Filtros suficientes | 2 a 3 cards com foto, preço, quartos, bairro | Chat |
| L7 | **Refinamento** | Lead reage aos imóveis | Ajuste de filtros e nova busca | Chat |
| L8 | **Proposta de agendamento** | Lead demonstra interesse | Agente oferece horários concretos, não "quando você prefere?" | Chat |
| L9 | **Confirmação** | Lead escolhe horário | Resumo do agendamento + confirmação | Chat |
| L10 | **Handoff para humano** | Lead pede pessoa, ou pergunta fora de escopo, ou score alto | Agente avisa que vai chamar um corretor e para de responder | Chat |
| L11 | **Fallback** | Agente não entende após 2 tentativas | Reconhece a limitação e oferece humano | Chat |
| L12 | **Follow-up proativo** | Conversa parada há N horas | Agente reabre com contexto: "sobre o apê de 2 quartos em Moema..." | Chat |
| L13 | **Opt-out** | Lead pede para parar | Agente confirma, marca `do_not_contact`, encerra follow-ups | Chat |
| L14 | **Retorno** | Lead volta dias depois | Agente reconhece o histórico e retoma de onde parou | Chat |

**Regras que valem a pena definir explicitamente no MVP:**
- Uma pergunta por mensagem. Duas perguntas juntas quebram a qualificação
- Nunca perguntar o que já foi respondido — a máquina de slots é a fonte da verdade, não o LLM
- Follow-up respeita janela 9h–20h e limite de 3 tentativas
- Handoff é irreversível sem ação humana — o agente não "retoma sozinho"

### 1.2 Corretor

| # | Ponto de interação | Gatilho |
|---|---|---|
| C1 | **Login** | Acesso ao painel |
| C2 | **Notificação de lead qualificado** | Lead atinge score mínimo (no MVP: badge no painel; depois: e-mail/push) |
| C3 | **Consulta da fila de leads** | Rotina diária |
| C4 | **Leitura da ficha** | Abre um lead — resumo IA primeiro, transcrição depois |
| C5 | **Assumir conversa** | Botão que pausa o agente |
| C6 | **Responder manualmente** | Envia mensagem pelo mesmo chat |
| C7 | **Devolver ao agente** | Botão que reativa a automação |
| C8 | **Atualizar status** | Marca ganho / perdido / em negociação |
| C9 | **Consultar agenda** | Ver visitas do dia |

### 1.3 Gerente comercial

| # | Ponto de interação | Gatilho |
|---|---|---|
| G1 | **Métricas de funil** | Abre o painel — números no topo da lista de leads |
| G2 | **Visão de todos os leads** | Mesma tela do corretor, sem filtro de propriedade |
| G3 | **Reatribuição de lead** | Corretor sem capacidade ou lead mal distribuído |

### 1.4 Fora do MVP (deliberadamente)

Vale citar na apresentação como roadmap consciente, não esquecimento:
- Tela de configuração do agente (prompts, roteiros, horários) — no MVP fica em arquivo de config
- Cadastro/CRUD de imóveis — catálogo entra por seed
- Gestão de usuários — usuários vêm por seed
- Relatório por campanha de marketing

---

## Parte 2 — Telas

**Seis telas.** Métricas moram no topo da lista de leads em vez de virarem tela própria, e o console de conversa vive dentro da ficha do lead — duas decisões que cortam telas sem cortar função.

### Tela 1 — Widget de chat (público)

```
┌──────────────────────────────────┐
│ 🏠 Imobiliária Demo        — ✕   │
├──────────────────────────────────┤
│                                  │
│  ┌────────────────────────────┐  │
│  │ Oi! Sou o assistente da    │  │
│  │ Imobiliária Demo 😊        │  │
│  │ Como posso ajudar?         │  │
│  └────────────────────────────┘  │
│                     ┌──────────┐ │
│                     │ Procuro  │ │
│                     │ apê ZS   │ │
│                     └──────────┘ │
│  ┌────────────────────────────┐  │
│  │ ┌────────────────────────┐ │  │
│  │ │ [foto]                 │ │  │
│  │ │ Apto 2q · Moema        │ │  │
│  │ │ R$ 680.000             │ │  │
│  │ │ [Ver detalhes]         │ │  │
│  │ └────────────────────────┘ │  │
│  └────────────────────────────┘  │
│  ● ● ●  digitando...             │
├──────────────────────────────────┤
│ [ Digite sua mensagem...    ] ➤  │
└──────────────────────────────────┘
```

Elementos: balões diferenciados, indicador de digitação com delay artificial (300–800ms, humaniza muito), cards de imóvel inline, banner discreto de opt-in na abertura, badge "Falando com um corretor" quando há handoff.

### Tela 2 — Login

Minimalista: e-mail + senha, logo, sem cadastro público. Usuários por seed.

### Tela 3 — Painel de leads (tela principal)

```
┌─────────────────────────────────────────────────────────────────┐
│  SDR Imobiliário          Leads · Agenda        Ana (corretora) │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │
│  │ 1ª resp. │ │Qualific. │ │Agendadas │ │ Recuperados por  │   │
│  │  12 seg  │ │   64%    │ │    18    │ │ follow-up:   23  │   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘   │
├─────────────────────────────────────────────────────────────────┤
│  [Todos ▾] [Quentes] [Aguardando] [Agendados]   🔍 buscar...    │
├─────────────────────────────────────────────────────────────────┤
│  🔥 Camila Rocha    Compra    Moema · 700k · 2q     há 2 min    │
│     "Contrato de aluguel vence em 6 semanas"        ▸           │
├─────────────────────────────────────────────────────────────────┤
│  🔥 Marcos Lima     Invest.   2–3 mi · comercial    há 18 min   │
│     "Já tem 4 imóveis, busca yield sólido"          ▸           │
├─────────────────────────────────────────────────────────────────┤
│  🌡 João Prado      Compra    Perto metrô · 450k    há 1 h      │
│     "Primeiro imóvel, ainda não simulou crédito"    ▸           │
├─────────────────────────────────────────────────────────────────┤
│  ❄ Renata Alves    Aluguel   —                     há 2 dias   │
│     Follow-up 2/3 enviado · sem resposta            ▸           │
└─────────────────────────────────────────────────────────────────┘
```

A linha de prévia com a frase-chave extraída pela IA é o detalhe que faz o corretor priorizar sem abrir nada.

### Tela 4 — Ficha do lead (drawer lateral)

```
┌────────────────────────────────────────────┐
│  Camila Rocha              🔥 Quente   ✕   │
│  (11) 9xxxx-1234 · Widget web              │
├────────────────────────────────────────────┤
│  RESUMO (IA)                               │
│  Busca apartamento de 2 quartos em Moema   │
│  ou Vila Mariana, até R$ 700 mil, sendo    │
│  um dos quartos para home office.          │
│  Urgência alta: contrato de aluguel vence  │
│  em 6 semanas. Aceitou call na quinta.     │
├────────────────────────────────────────────┤
│  QUALIFICAÇÃO                              │
│  Intenção     Compra                       │
│  Orçamento    até R$ 700.000               │
│  Quartos      2                            │
│  Região       Moema / Vila Mariana         │
│  Urgência     Alta (6 semanas)             │
│  Pagamento    — não informado              │
├────────────────────────────────────────────┤
│  [ Assumir conversa ]  [ Agendar ]         │
│  Status: [ Qualificado ▾ ]                 │
├────────────────────────────────────────────┤
│  CONVERSA                            ⌄     │
│  ┌──────────────────────────────────────┐  │
│  │ (transcrição completa, rolável)      │  │
│  │ ...                                  │  │
│  └──────────────────────────────────────┘  │
│  [ Digite para responder...        ] ➤     │
├────────────────────────────────────────────┤
│  LINHA DO TEMPO                      ⌄     │
│  10:02 Lead criado · widget                │
│  10:04 Intenção identificada: compra       │
│  10:09 Qualificado (score 87)              │
│  10:10 Reunião proposta                    │
└────────────────────────────────────────────┘
```

Ordem intencional: **resumo antes de dados, dados antes de transcrição**. O corretor tem 20 segundos.

### Tela 5 — Agenda

Lista simples agrupada por dia: horário, lead, tipo (visita/call), imóvel, status. Sem calendário visual no MVP — lista resolve e custa um décimo do esforço.

### Tela 6 — Catálogo (somente leitura)

Grid de imóveis com filtros básicos. Existe para dar credibilidade na demo: prova que os imóveis sugeridos pelo agente são reais na base, não alucinação.

---

## Parte 3 — Arquitetura

### 3.1 Decisão central: monolito modular

Microserviços num MVP de hackathon custam tempo em orquestração e entregam zero valor de demo. Mas monolito bagunçado não escala.

**A saída: monolito modular com fronteiras internas rígidas e worker separado desde o dia 1.**

Três propriedades garantem a escalabilidade sem reescrita:

1. **API stateless** — nenhum estado em memória de processo. Escala horizontal é só aumentar réplicas
2. **Estado externalizado** — Postgres e Redis são serviços externos, não processos filhos
3. **Comunicação por fila desde o início** — o worker já é um processo separado consumindo fila. Extrair para outro serviço depois é mudar deploy, não código

### 3.2 Diagrama de componentes

```
                       ┌─────────────────┐
                       │  Widget Web     │
   Leads ──────────────┤  Telegram Bot   │
                       └────────┬────────┘
                                │ HTTP / Webhook
                    ┌───────────▼───────────┐
                    │   CHANNEL ADAPTERS    │
                    │  web · telegram       │──── (whatsapp: plug futuro)
                    └───────────┬───────────┘
                                │ InboundMessage (formato único)
   ┌────────────────────────────▼────────────────────────────┐
   │                    API — FastAPI (stateless)             │
   │  /webhook  ·  /api/leads  ·  /api/conversations  · /auth │
   └────────────┬─────────────────────────────┬───────────────┘
                │                             │
     ┌──────────▼──────────┐                  │
     │   ORQUESTRADOR      │                  │
     │  ┌───────────────┐  │                  │
     │  │ Slot Machine  │  │  ← decide o que falta perguntar
     │  ├───────────────┤  │
     │  │ LLM Client    │  │  ← Claude, via interface abstrata
     │  ├───────────────┤  │
     │  │ Tool Registry │  │
     │  │  buscar_imovel│  │
     │  │  agendar      │  │
     │  │  handoff      │  │
     │  └───────────────┘  │
     └──────────┬──────────┘                  │
                │                             │
   ┌────────────▼─────────────────────────────▼───────────────┐
   │  SERVICES (domínio)                                       │
   │  LeadService · PropertyService · SchedulingService        │
   │  SummaryService · ScoringService · EventBus               │
   └────────────┬──────────────────────────────────────────────┘
                │
   ┌────────────▼────────────┐        ┌─────────────────────────┐
   │  PostgreSQL             │        │  Redis                  │
   │  leads · conversations  │        │  sessão · cache · fila  │
   │  messages · properties  │◄──────►│                         │
   │  appointments · events  │        └───────────┬─────────────┘
   └─────────────────────────┘                    │
                                       ┌──────────▼──────────┐
                                       │  WORKER (processo   │
                                       │  separado)          │
                                       │  · follow-up sweep  │
                                       │  · resumo assíncrono│
                                       │  · CRM outbox       │
                                       └─────────────────────┘

   ┌──────────────────────────────────────────────────────────┐
   │  DASHBOARD — Next.js  →  consome a mesma API             │
   └──────────────────────────────────────────────────────────┘
```

### 3.3 Estrutura de pastas

```
app/
├── channels/           # Adapters — a fronteira que protege o resto
│   ├── base.py         #   ChannelAdapter (ABC): receive, send, send_media
│   ├── web.py
│   ├── telegram.py
│   └── registry.py
├── agent/
│   ├── orchestrator.py # Núcleo — stateless
│   ├── slots.py        # Roteiros por intenção
│   ├── prompts/
│   ├── tools/          # Funções expostas ao LLM
│   └── llm/            # LLMClient (ABC) + implementação Anthropic
├── domain/             # Entidades e regras puras, sem I/O
│   ├── lead.py
│   ├── scoring.py
│   └── events.py
├── services/           # Casos de uso
├── repositories/       # Acesso a dados — troca de banco não vaza
├── api/
│   ├── webhooks.py
│   ├── leads.py
│   └── deps.py
├── workers/
│   ├── followup.py
│   └── summarize.py
└── core/               # config (env), db, redis, logging, security
```

Regra de dependência: `api → services → domain`. `domain` não importa nada de fora. É o que permite testar a lógica de qualificação sem subir banco.

### 3.4 Modelo de dados mínimo

```
leads              id, name, phone, email, channel, external_id,
                   intent, status, score, assigned_broker_id,
                   consent_at, do_not_contact, created_at

conversations      id, lead_id, channel, state, slots (jsonb),
                   summary, is_paused, last_message_at

messages           id, conversation_id, role, content,
                   metadata (jsonb), created_at

properties         id, title, type, price, bedrooms, neighborhood,
                   city, description, image_url, is_active

appointments       id, lead_id, broker_id, property_id,
                   scheduled_at, type, status

events             id, lead_id, type, payload (jsonb), created_at
                   -- append-only: dashboard, auditoria e métricas

followup_jobs      id, conversation_id, attempt, scheduled_for, status
```

`slots` em JSONB é a escolha certa aqui: os roteiros de qualificação vão mudar toda semana durante o desenvolvimento, e schema rígido viraria migration a cada ajuste.

### 3.5 Fluxos

**Síncrono — mensagem do lead**
```
1. Canal → webhook → Adapter normaliza
2. Carrega conversa + slots (Redis, fallback Postgres)
3. Orquestrador: slots faltantes + histórico → prompt
4. LLM responde (pode chamar tool)
5. Executa tool se houver → repete
6. Persiste mensagem, atualiza slots, emite evento
7. Adapter envia resposta
8. Enfileira: resumo + agendamento de follow-up
```

**Assíncrono — follow-up**
```
1. Worker roda a cada 15 min
2. Busca conversas: sem resposta > N h, ativas,
   tentativas < 3, dentro de 9h–20h, sem do_not_contact
3. Gera mensagem com contexto (usa o resumo, não a transcrição inteira)
4. Envia via Adapter · registra tentativa e evento
```

### 3.6 Deploy e caminho de escala

**Local**
```yaml
services:
  api:      FastAPI · uvicorn
  worker:   mesmo código, entrypoint diferente
  db:       postgres:16
  redis:    redis:7
  web:      next.js
```

Um `docker compose up` sobe tudo. É isso que torna a demo confiável.

**Produção inicial** — Render, Railway ou Fly.io: API e worker como serviços separados, Postgres e Redis gerenciados. Sobe em uma tarde.

**Caminho de escala, sem reescrita:**

| Pressão | Ação | Toca o código? |
|---|---|---|
| Mais conversas simultâneas | Réplicas da API | Não |
| Follow-ups atrasando | Réplicas do worker | Não |
| Fila insuficiente | Redis → SQS/Pub-Sub | Só a implementação da interface de fila |
| Banco saturado | Read replica + pgbouncer | Não |
| RAG entra em cena | `CREATE EXTENSION vector` no mesmo Postgres | Novo módulo, nada existente |
| WhatsApp aprovado | Nova classe em `channels/` | Uma classe |
| Multiagentes | Roteador antes do orquestrador | Camada nova, orquestrador intacto |
| Voice AI | Middleware STT no Adapter | Orquestrador intacto |
| Serviço precisa isolar | Extrai módulo → serviço próprio | Fronteiras já existem |

### 3.7 Práticas que custam pouco e sustentam a escala

- **12-factor:** toda config por variável de ambiente, logs em stdout
- **Idempotência nos webhooks:** canal reenvia, e o sistema não pode responder duas vezes
- **Timeout e retry no LLM** com fallback de mensagem genérica — a conversa nunca "morre"
- **Rate limit por sessão** contra abuso e custo descontrolado
- **Migrations versionadas** (Alembic) desde o primeiro commit
- **Logs estruturados em JSON** com `lead_id` e `conversation_id` — pré-requisito para plugar Langfuse depois sem refatorar
- **Health check** em `/health` — exigência de qualquer orquestrador de container

---

## Resumo executivo

| Dimensão | Decisão |
|---|---|
| Telas | 6 (widget, login, painel, ficha, agenda, catálogo) |
| Serviços em execução | 4 (api, worker, postgres, redis) + frontend |
| Padrão arquitetural | Monolito modular, stateless, worker desde o dia 1 |
| Abstrações que sustentam o futuro | `ChannelAdapter`, `LLMClient`, `Repository`, fila |
| Deploy | Docker Compose → PaaS → cloud gerenciada |
| Custo de escalar | Réplicas e serviços gerenciados, não reescrita |

O argumento de arquitetura para a banca: **cada diferencial do enunciado tem um ponto de encaixe já previsto no desenho.** RAG entra no Postgres que já existe, WhatsApp é uma classe no diretório de canais, multiagentes é uma camada antes do orquestrador, voice é um middleware no adapter. Não construímos tudo — construímos o lugar de tudo.