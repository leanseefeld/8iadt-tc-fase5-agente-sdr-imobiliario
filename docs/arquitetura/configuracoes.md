# Configurações

Registro de tudo que hoje é variável de ambiente e que, num produto, moraria em
um painel de administração. Cada linha diz o escopo natural: **global** (por
instalação) ou **agência** (por tenant). Iniciado em 08/09/2026; toda spec que
cria uma chave acrescenta a linha aqui no mesmo commit.

| Chave | Padrão | Escopo | Spec | O que controla |
|---|---|---|---|---|
| `MODEL_PROFILE` | — | global (agência no futuro) | 016 | o perfil do modelo em `config/models/`: endpoint, modelo, cabeçalho de autenticação, raciocínio (`thinking`, `reasoning_effort` até `low`) e tetos de saída da resposta e da extração (ADR 23) |
| `MODEL_PROFILES_DIR` | `config/models` | global | 016 | onde ficam os perfis; só um teste aponta outro lugar |
| `OMLX_API_KEY`, `AZURE_OPENAI_BASE_URL`, `AZURE_OPENAI_API_KEY` | — | global | 016 | os segredos que os perfis leem pelo nome |
| `MODEL_HISTORY_WINDOW` | `12` | agência | 004 | mensagens recentes enviadas ao modelo |
| `MODEL_TIMEOUT_MS`, `MODEL_MAX_RETRIES` | `30000`, `2` | global | 001 | limite e repetição por chamada |
| `CHAT_DEBOUNCE_MS` | `3000` | agência | 004 | espera após a última mensagem do lead antes de iniciar o turno |
| `CHAT_MESSAGE_BUDGET`, `CHAT_BUDGET_WINDOW_MINUTES` | `60`, `30` | agência | 004 | mensagens por sessão por janela |
| `CHAT_MAX_MESSAGE_CHARS` | `1000` | agência | 004 | tamanho máximo de uma mensagem do lead |
| `CHAT_TYPING_DELAY_MS` | `300–800` | agência | 004 | pausa humanizada antes do primeiro token |
| `SSE_PULSE_INTERVAL_MS` | `15000` | global | 004 | pulso de keep-alive nos streams |
| `LANGFUSE_UI_PORT` | `3102` | global | 004 | porta do host em que a interface do Langfuse é publicada (só o Compose lê) |
| `SUMMARY_DEBOUNCE_SECONDS` | `20` | agência | 005 | espera após o último turno antes de resumir |
| `SUMMARY_BATCH_SIZE` | `10` | global | 005 | conversas resumidas por varredura |
| `LEADS_PAGE_SIZE` | `25` | agência | 005 | linhas por página em `/leads` |
| `DASHBOARD_LIVE_WINDOW_MINUTES` | `10` | agência | 005 | "ao vivo" = última mensagem do lead dentro da janela |
| `SCHEDULING_MIN_NOTICE_MINUTES` | `120` | agência | 006 | antecedência mínima de uma visita |
| `SCHEDULING_PREFERRED_TIMES` | `10:00,14:00,16:30` | agência | 006 | ordem de preferência dos horários propostos |
| Disponibilidade por corretor | seg–sex 09–18 | usuário | 006 | `users.availability`, editável na agenda |
| `FOLLOWUP_WINDOW_START/END`, `FOLLOWUP_TIMEZONE` | `09:00`, `20:00`, `America/Sao_Paulo` | agência | 006 | janela de envio |
| `FOLLOWUP_FIRST_DELAY_MINUTES`, `FOLLOWUP_MAX_ATTEMPTS`, `FOLLOWUP_BACKOFF_FACTOR` | `240`, `3`, `3` | agência | 006 | cadência das tentativas (demo: `5`) |
| `WORKER_SWEEP_INTERVAL_MS` | `900000` | global | 001 | frequência do worker (demo: `15000`) |
| `AUTH_SECRET` | — | global | 003 | assinatura do cookie |
