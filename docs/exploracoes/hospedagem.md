# Exploração: hospedagem na Azure

> **Status (10/10/2026): exploração de viabilidade, nada implantado.** Nenhum recurso
> foi criado na Azure e nenhuma linha de código mudou. O registro de
> [`restricoes-de-implantacao.md`](../arquitetura/restricoes-de-implantacao.md) §7
> continua verdadeiro: não há ambiente na nuvem.

> **Não normativo.** Avalia uma proposta de arquitetura recebida pelo desenvolvedor
> ("AI SDR — Cloud Architecture Proposal": App Service + Function Timer + Postgres
> gerenciado + Azure OpenAI + Key Vault + ACR, com o domínio no Route 53) contra o
> código como ele é hoje. A escolha final vira ADR quando for feita.

**Objetivo declarado:** o caminho mais curto para hospedar o sistema e ter o primeiro
cliente rodando, até duas imobiliárias. Sem SLA, sem cadastro ou cobrança. Não
gastar crédito da Azure quando nada estiver rodando.

---

## 1. Resposta curta

**Viável, sem mudar a arquitetura.** A imagem de produção (`runner`) já existe e foi
exercitada nesta exploração: build, migrations, seed, `next start`, uma conversa de
ponta a ponta por SSE e uma varredura do worker (§2).

A proposta funciona como está, mas duas escolhas dela trabalham contra o objetivo de
não pagar por tempo ocioso. A recomendação é trocá-las:

| Proposta | Recomendado | Por quê |
|---|---|---|
| App Service (Docker) | **Azure Container Apps**, plano Consumption, `min-replicas 0` | App Service cobra o plano 24 h por dia, mesmo parado. Container Apps escala a zero e não cobra nada nesse estado |
| Azure Function Timer → `POST /api/internal/worker/sweep` | **Container Apps Job agendado**, mesma imagem, outro comando | O ping HTTP a cada 15 min **acorda a aplicação** e a mantém ativa pelo cooldown (300 s), cerca de um terço do dia. O job roda o worker direto no banco: sem rota interna, sem autenticação a inventar, sem recurso Functions e sem conta de storage |
| Migrations rodando no GitHub Actions | **Container Apps Job manual** com `node src/db/migrate.ts` | O runner do GitHub tem IP variável e não alcança um Postgres com firewall. O job roda dentro da Azure, com a mesma imagem |
| Key Vault | **Secrets do próprio Container Apps** (Key Vault opcional) | São criptografados e chegam à aplicação como variável de ambiente, que é o que `core/config.ts` lê. Key Vault acrescenta identidade gerenciada e RBAC sem ganho para duas imobiliárias |

O resto da proposta se mantém: Azure Database for PostgreSQL Flexible Server, Azure
OpenAI pelo perfil `azure_nano` (ou `azure_luna_none`), ACR, Langfuse Cloud e o
domínio no Route 53.

**Custo esperado** (preços de tabela da API de varejo da Azure, consultada em
10/10/2026, East US 2): **cerca de US$ 21/mês parado e US$ 28/mês com uso em horário
comercial**, quase tudo Postgres. Detalhe em §5.

---

## 2. O que foi verificado nesta exploração

Rodado num contêiner Linux, com a imagem `runner` do `Dockerfile` e um
`postgres:17-alpine`, simulando a topologia da nuvem: um `migrate` avulso, a
aplicação com `npm run start` e `NODE_ENV=production`, e o worker separado. O
modelo apontava para um endpoint Azure inválido, de propósito: sem chave real, o
teste é do encanamento, não da qualidade das respostas.

| Verificação | Resultado |
|---|---|
| `npm run build` sem `.env` e sem banco | Passa. O build não precisa de segredo, então o CI consegue gerar a imagem |
| `docker build --target runner` | Passa. **479 MB comprimida, 1,6 GB descompactada** (leva `node_modules` inteiro, inclusive dependências de desenvolvimento) |
| `node src/db/migrate.ts` na imagem `runner` | Aplica as 4 migrations em ~0,3 s |
| `node src/db/seed/index.ts` na imagem `runner` | Semeia a agência `demo`, 3 usuários, 100 imóveis, 3 leads |
| `npm run start` até `/api/health/ready` = 200 | **~2,1 s** com a imagem já baixada. 246 MiB de memória em repouso |
| `/login` e `/chat/demo` | 200, em 0,17 s e 0,08 s |
| Conversa por SSE: `POST /api/chat` → debounce → turno → `LISTEN/NOTIFY` → stream | Funciona. O stream entregou `pulse`, `chunk` e `message`. Com o modelo fora, a resposta foi o *fallback* ("Tive um problema técnico aqui…"), como previsto |
| `node src/worker/index.ts` | Varre os três consumidores logo ao subir, em ~1 s. 186 MiB. `SIGTERM` encerra limpo, com código 0 |

**Não verificado, e só se verifica na Azure:** o tempo de partida a frio (download
da imagem), o corte de 240 s do ingress sobre o SSE (§4.3), o TLS até o Postgres
gerenciado (§6) e a qualidade das respostas com o modelo real. A última já foi
validada nas demonstrações com o perfil `azure_*`, e não depende de onde a
aplicação roda.

---

## 3. A proposta contra o código

Pontos em que a proposta presume algo diferente do que o código faz:

1. **"Adicionar Redis Pub/Sub se houver mais de uma instância."** Não é necessário.
   O SSE já usa `LISTEN/NOTIFY` do Postgres, com uma conexão por réplica
   ([`visao-geral.md`](../arquitetura/visao-geral.md) §9, `core/notifier.ts`): um
   evento gravado por qualquer réplica, ou pelo worker, chega aos streams de todas.
   Redis também contraria a regra "No Redis" do `AGENTS.md`. **Consequência
   prática:** a `DATABASE_URL` precisa apontar para a porta direta do servidor
   (5432), **não** para o PgBouncer embutido do Flexible Server (6432), porque
   `LISTEN` não sobrevive ao pool em modo transação.
2. **"Webhook do WhatsApp no mesmo app."** O WhatsApp **não está implementado**
   ([`restricoes-de-implantacao.md`](../arquitetura/restricoes-de-implantacao.md)
   §6). A hospedagem não depende dele. O que ela muda é que passa a existir uma URL
   pública com HTTPS, que era o bloqueio citado no registro.
3. **"Proteger contra varreduras sobrepostas."** Já está protegido. Os consumidores
   reivindicam linhas com `FOR UPDATE SKIP LOCKED` e o turno é guardado por
   `claimTurn`. Há teste de integração com dois *claimers*
   (`tests/followup-claim.test.ts`). Duas execuções do job ao mesmo tempo não
   duplicam trabalho.
4. **Organização sugerida (`src/worker/sweep.ts` + rota interna).** A metade útil é
   extrair a varredura de `src/worker/index.ts` para uma função reutilizável. A rota
   interna deixa de ser necessária com o job (§7.1).
5. **"Usar o comando de produção."** Já existe: o alvo `runner` termina em
   `npm run start` (`next start`). Nada a mudar no `Dockerfile` para a primeira
   implantação.

---

## 4. Arquitetura recomendada

```text
                Route 53 (CNAME app.<domínio> → FQDN do Container App)
                                    │
                                    ▼
     ┌──────────── Container Apps Environment (Consumption) ────────────┐
     │                                                                  │
     │  sdr-app      Container App, ingress externo, porta 3100         │
     │               imagem runner, `npm run start`                     │
     │               min 0 / max 1 réplica, 0,5 vCPU / 1 GiB            │
     │                                                                  │
     │  sdr-sweep    Job agendado, cron */15 * * * *                    │
     │               mesma imagem, uma varredura e sai                  │
     │                                                                  │
     │  sdr-migrate  Job manual, `node src/db/migrate.ts`               │
     │               mesma imagem, disparado pelo deploy                │
     └──────────────────────────────────────────────────────────────────┘
          │  LISTEN/NOTIFY + SQL (porta 5432, TLS)       │ HTTPS
          ▼                                              ▼
   PostgreSQL Flexible Server, B1ms            Azure OpenAI (perfil azure_*)
                                               Langfuse Cloud (opcional)

   GitHub Actions ──build runner──▶ ACR Basic ──▶ sdr-migrate ──▶ sdr-app / sdr-sweep
```

É o desenho de [`visao-geral.md`](../arquitetura/visao-geral.md) §7: uma imagem, os
processos `app` e `worker` separados e o Postgres gerenciado. Nada específico da Azure
entra no código. O que é da Azure fica na configuração de implantação.

### 4.1 Escalar a zero, na prática

- **Partida a frio.** Depois de 300 s sem requisição, a réplica sai. A próxima
  requisição baixa a imagem (479 MB, se o nó não a tiver em cache) e sobe o Next.js
  (~2 s medidos). Estimativa: **dezenas de segundos** na primeira carga do chat
  depois de um período ocioso. O número precisa ser medido na Azure. Para a fase de
  demonstração isso não pesa. **Quando o widget do primeiro cliente estiver no ar**,
  um lead esperando 20 a 30 s é um lead perdido. Nesse momento, vale passar para
  `--min-replicas 1`, que custa cerca de US$ 12/mês em tarifa ociosa (§5).
- **Streams abertos mantêm a réplica viva.** Um SSE aberto é uma requisição em
  andamento. Um corretor que deixa a aba de `/leads` aberta durante a noite mantém
  a aplicação em tarifa ativa. Pela definição da Azure ("processing requests"),
  isso é provável, mas não foi medido. O teto é de cerca de US$ 34/mês se ficar
  ativa 24 h com 0,5 vCPU / 1 GiB. Mitigações: `max-replicas 1` limita a uma
  réplica, e um orçamento com alerta avisa (§8). Se virar problema, o stream do
  painel pode fechar quando a aba fica oculta, uma mudança pequena de UI.
- **O debounce do turno é seguro.** O timer de 3 s mora no processo
  (`channels/web.ts`), mas o `POST` que o arma é uma requisição, e o widget mantém
  o SSE aberto. A réplica não sai no meio. Se sair, `unanswered-turns` refaz o turno
  na próxima varredura.
- **O worker não depende da aplicação.** O job grava o follow-up e dá o `NOTIFY`.
  Se o lead estiver com o widget aberto, a réplica da aplicação está de pé e entrega.
  Se não estiver, a mensagem aparece quando ele voltar, lida do banco.

### 4.2 Cadência da varredura

Hoje a varredura roda a cada `WORKER_SWEEP_INTERVAL_MS` (15 min). Com o job, a
cadência vira o cron. Efeitos de 15 min: o follow-up sai até 15 min depois de
vencido, o resumo do lead aparece no painel até 15 min depois da conversa, e um
turno perdido é refeito em até 15 min. Um cron de `*/5` reduz isso a 5 min, ainda
dentro da cota gratuita (§5).

### 4.3 O corte de 240 s do ingress

A documentação do Container Apps fixa **"Request time out is 240 seconds"** no
ingress HTTP. O mais provável é que um SSE seja encerrado aos 4 minutos, mesmo com
o `pulse` a cada 15 s. Pela leitura do código, o efeito é invisível:

- a rota manda `retry: 3000`, e o `EventSource` reconecta sozinho em 3 s;
- durante a reconexão o `readyState` é `CONNECTING`, não `CLOSED`, então o widget
  não mostra "Conexão perdida". O alerta só aparece depois de dois `pulse` perdidos
  (31 s), e a reconexão manda um `pulse` imediato;
- mensagens gravadas nesse intervalo voltam por `Last-Event-ID`. Só um `chunk`
  (animação de digitação) pode se perder, e isso já é aceito pelo desenho.

**A verificar na primeira implantação:** deixar o chat e o painel abertos por 10
minutos e confirmar que não aparece a faixa "Conexão perdida". O App Service tem
limite equivalente (230 s sem resposta), mas conta ociosidade, e o `pulse` o
evitaria.

---

## 5. Custos

Preços de tabela em USD, da API de varejo da Azure (`prices.azure.com`), consultada
em 10/10/2026. Mês de 730 h. Sem impostos e sem descontos.

| Recurso | East US 2 | Brazil South |
|---|---|---|
| Postgres Flexible B1ms (1 vCore, 2 GiB), 24 h | US$ 0,017/h → **12,41** | US$ 0,035/h → **25,55** |
| Armazenamento do Postgres, 32 GB | US$ 0,115/GB → **3,68** | US$ 0,2185/GB → **6,99** |
| ACR Basic | US$ 0,1666/dia → **5,07** | **5,07** |
| Container Apps, vCPU ativa / ociosa | US$ 0,000024 / 0,000003 por s | igual |
| Container Apps, memória ativa ou ociosa | US$ 0,000003 por GiB·s | igual |
| Cota gratuita mensal do Container Apps | 180.000 vCPU·s, 360.000 GiB·s, 2 M requisições | igual |
| *Para comparação:* App Service B1 Linux | US$ 0,017/h → 12,41 | US$ 0,020/h → 14,60 |

**Cenários (East US 2):**

| Cenário | Mês |
|---|---|
| Parado: ninguém usando, Postgres ligado | ~US$ 21 (Postgres 16,09 + ACR 5,07; app e job dentro da cota) |
| Uso real: duas imobiliárias, painel aberto 10 h × 22 dias | ~US$ 28 (soma ~7 de Container Apps acima da cota) |
| Sem partida a frio: `min-replicas 1` | +~US$ 12 de tarifa ociosa |
| "Hibernado": Postgres parado | ~US$ 9 (só armazenamento + ACR). A Azure religa o Postgres sozinha depois de 7 dias |
| *A proposta original* (App Service B1 + Function + ACR + Postgres) | ~US$ 34 fixos, usando ou não |

O job de varredura a cada 15 min, com ~30 s por execução a 0,25 vCPU / 0,5 GiB,
usa ~22.000 vCPU·s por mês. A cada 5 min, ~65.000. Nos dois casos fica dentro da
cota gratuita.

**Duas alavancas que mudam a conta:**

1. **Conta gratuita da Azure.** Nos primeiros 12 meses de uma conta gratuita, a Azure
   inclui **750 h/mês de Postgres Flexible B1ms, 32 GB de armazenamento e 32 GB de
   backup**. Isso cobre exatamente o servidor acima e derruba o custo para ~US$ 5 a
   12/mês. Vale conferir se a assinatura onde estão os créditos é desse tipo. Não
   confirmei se a assinatura Azure for Students inclui o mesmo benefício.
2. **Região.** O Container Apps custa o mesmo nas duas regiões, mas o Postgres no
   Brazil South custa o dobro (+~US$ 16,50/mês). Para a POC, a sugestão é ficar na
   região do recurso Azure OpenAI que já existe e ir para o Brazil South quando um
   contrato pedir dados no Brasil (LGPD). Aplicação e banco ficam sempre na
   mesma região. A latência que o lead sente é uma ida e volta até o servidor, mais
   o modelo.

Itens de custo desprezível ou zero: Log Analytics (o ambiente cria um workspace;
os logs JSON desta escala ficam bem abaixo da franquia gratuita mensal), Key Vault
(se usado), Langfuse Cloud Hobby (gratuito na faixa de uma POC) e Route 53 (já pago).
O Azure OpenAI é por token e não depende da hospedagem.

**Armadilha a evitar:** criar o ambiente do Container Apps com um *workload profile*
dedicado. O medidor "Environment Management Hour" (US$ 0,10/h em East US 2, ~US$ 73/mês)
só vale para o plano Dedicated. O ambiente precisa ser só Consumption.

---

## 6. Configuração

O mesmo contrato de `.env.example`, com estes valores na nuvem:

| Variável | Valor | Nota |
|---|---|---|
| `NODE_ENV` | `production` | Liga o `Secure` no cookie de sessão (`core/auth.ts`) |
| `APP_PORT` | `3100` | Igual ao `--target-port` do ingress |
| `DATABASE_URL` | `postgresql://<user>:<senha>@<servidor>.postgres.database.azure.com:5432/sdr?sslmode=verify-full` | Porta 5432, não 6432 (§3.1). `verify-full` explícito: o `pg` 8.23 já trata `require` como `verify-full`, mas emite aviso de segurança. Os certificados do Flexible Server encadeiam em raízes públicas que o Node já conhece. Confirmar na primeira conexão |
| `AUTH_SECRET` | `openssl rand -base64 32` | Secret |
| `MODEL_PROFILE` | `azure_nano` ou `azure_luna_none` | |
| `AZURE_OPENAI_BASE_URL`, `AZURE_OPENAI_API_KEY` | do recurso existente | Chave em secret |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` | Langfuse Cloud (`https://cloud.langfuse.com` ou `https://us.cloud.langfuse.com`) | Opcional: sem as chaves, o rastreamento é no-op |
| `FOLLOWUP_FIRST_DELAY_MINUTES` | `240` | O `5` de demonstração não serve com cliente real |

**Dados pessoais.** Os traces do Langfuse e as chamadas ao Azure OpenAI levam
mensagens de leads, com nome e telefone. Para a POC, tudo bem. Antes do primeiro
cliente, confirmar os termos de tratamento de dados dos dois serviços e citá-los no
aviso de privacidade da imobiliária. A proposta já apontava isso.

---

## 7. O que falta no código

### 7.1 Necessário: o worker em modo "uma varredura e sai"

`src/worker/index.ts` só sabe rodar para sempre (`setInterval`). Um job precisa de
um processo que varra uma vez, faça o *flush* do Langfuse, feche o pool e saia com
código 0. A mudança tem cerca de 20 linhas e não toca nenhum consumidor:

- extrair `sweep()` para uma função exportada (por exemplo,
  `src/worker/sweep.ts`), que devolve se algum consumidor falhou;
- `src/worker/index.ts` continua igual para o Compose (timer + porta de *health*);
- um segundo ponto de entrada (`src/worker/once.ts`) chama a função uma vez e sai.
  O comando do job é `node src/worker/once.ts`.

**Alternativa sem código:** rodar o worker como um segundo Container App sem
ingress, `min = max = 1`, 0,25 vCPU / 0,5 GiB, com o comando atual. Custa ~US$ 6/mês
em tarifa ociosa e é exatamente o processo do Compose. É o caminho se a primeira
implantação vier antes da mudança.

### 7.2 Necessário para o primeiro cliente: cadastrar a imobiliária

Multi-tenancy existe em tempo de execução: o widget é `/chat/<slug>`, a sessão do
corretor carrega `agencyId`, e toda consulta filtra por agência (ADR 10). **O que não
existe é como criar uma agência.** O único caminho é `src/db/seed/index.ts`, que cria
a `demo`, três usuários fixos e imóveis de exemplo. Para o primeiro cliente falta um
script de provisionamento que receba a agência (nome, slug), os corretores (nome,
e-mail, papel, senha inicial com hash bcrypt) e o catálogo de imóveis (no formato de
`properties.json`). Ele roda da máquina do desenvolvedor contra o banco da nuvem,
com regra de firewall para o próprio IP (§8). Não há tela de troca de senha.

Uma restrição pequena: `login` procura o usuário só pelo e-mail
(`services/auth.ts`), e a unicidade é por agência e e-mail. O mesmo e-mail em duas
imobiliárias entra numa delas arbitrariamente. Com duas agências, basta não repetir
e-mails.

### 7.3 Não necessário, mas útil

- **Incorporar o widget no site da imobiliária.** O cookie da sessão do chat é
  `SameSite=Lax` (`core/auth.ts`). Num `<iframe>` dentro de outro domínio, o
  navegador não o envia, e o stream SSE perde a sessão. Para o primeiro cliente,
  **link direto** para `https://app.<domínio>/chat/<slug>` (botão no site, QR code,
  bio do Instagram) funciona sem mudança. Para *iframe*, é preciso `SameSite=None`
  com o resto das proteções revisado, ou um subdomínio do próprio cliente apontando
  para a aplicação.
- **Imagem menor.** `output: "standalone"` do Next reduziria os 479 MB e a partida a
  frio. Mas o worker e o `migrate` rodam `src/` direto com o `node_modules`
  inteiro, então a mudança precisa de cuidado. Fica para quando a partida a frio
  incomodar.
- **CI.** Não há. O workflow de deploy (§8.3) passa a ser o primeiro, e o
  `next build` dele vira a checagem de tipos que hoje roda à mão.

---

## 8. Roteiro de implantação

> **Não executado.** Comandos escritos contra a documentação da CLI `az`
> (`az extension add -n containerapp`), não testados nesta assinatura. Conferir
> cada um no primeiro uso.

### 8.1 Infraestrutura (uma vez)

```bash
RG=sdr-poc; LOC=eastus2; ENV=sdr-poc-env
ACR=sdrpoc$RANDOM            # nome global, só letras e números
PG=sdr-poc-pg-$RANDOM        # nome global
az group create -n $RG -l $LOC

# Orçamento com alerta: o freio contra a aba esquecida (§4.1). Mais simples pelo portal:
# Cost Management → Budgets → US$ 30/mês, alertas em 50 %, 80 % e 100 %.

az acr create -g $RG -n $ACR --sku Basic

# Postgres: acesso público restrito a serviços da Azure (0.0.0.0), TLS obrigatório.
# O IP de saída do Container Apps Consumption não é fixo; VNet fica para depois.
az postgres flexible-server create -g $RG -n $PG -l $LOC \
  --tier Burstable --sku-name Standard_B1ms --storage-size 32 --version 17 \
  --admin-user sdradmin --admin-password "$PG_PASSWORD" \
  --public-access 0.0.0.0 --database-name sdr
# pgvector, só quando houver RAG:
# az postgres flexible-server parameter set -g $RG -s $PG --name azure.extensions --value vector

az containerapp env create -g $RG -n $ENV -l $LOC   # Consumption (§5, armadilha)
```

### 8.2 Primeira implantação (à mão)

```bash
TAG=$(git rev-parse --short HEAD)
# Em Mac com Apple Silicon, --platform é obrigatório: a Azure roda amd64.
docker build --platform linux/amd64 --target runner -t $ACR.azurecr.io/sdr:$TAG .
az acr login -n $ACR && docker push $ACR.azurecr.io/sdr:$TAG

DB="postgresql://sdradmin:$PG_PASSWORD@$PG.postgres.database.azure.com:5432/sdr?sslmode=verify-full"
SECRETS="database-url=$DB auth-secret=$AUTH_SECRET aoai-key=$AZURE_OPENAI_API_KEY"
ENVV="NODE_ENV=production APP_PORT=3100 MODEL_PROFILE=azure_nano \
  DATABASE_URL=secretref:database-url AUTH_SECRET=secretref:auth-secret \
  AZURE_OPENAI_BASE_URL=$AZURE_OPENAI_BASE_URL AZURE_OPENAI_API_KEY=secretref:aoai-key"
IMG="--image $ACR.azurecr.io/sdr:$TAG --registry-server $ACR.azurecr.io --registry-identity system"

# Migrations: job manual, dentro da Azure.
az containerapp job create -g $RG -n sdr-migrate --environment $ENV $IMG \
  --trigger-type Manual --replica-timeout 300 --replica-retry-limit 0 \
  --parallelism 1 --replica-completion-count 1 --cpu 0.25 --memory 0.5Gi \
  --command "node" --args "src/db/migrate.ts" --secrets $SECRETS --env-vars $ENVV
az containerapp job start -g $RG -n sdr-migrate
az containerapp job execution list -g $RG -n sdr-migrate -o table   # esperar Succeeded

# Aplicação: escala a zero, no máximo uma réplica.
az containerapp create -g $RG -n sdr-app --environment $ENV $IMG \
  --ingress external --target-port 3100 \
  --cpu 0.5 --memory 1.0Gi --min-replicas 0 --max-replicas 1 \
  --secrets $SECRETS --env-vars $ENVV

# Varredura: depende de §7.1. Sem ela, usar a alternativa daquela seção.
az containerapp job create -g $RG -n sdr-sweep --environment $ENV $IMG \
  --trigger-type Schedule --cron-expression "*/15 * * * *" \
  --replica-timeout 600 --replica-retry-limit 0 --parallelism 1 --replica-completion-count 1 \
  --cpu 0.25 --memory 0.5Gi --command "node" --args "src/worker/once.ts" \
  --secrets $SECRETS --env-vars $ENVV
```

**Dados iniciais.** Liberar o próprio IP no firewall e rodar o seed ou o
provisionamento (§7.2) da máquina local:

```bash
az postgres flexible-server firewall-rule create -g $RG -n $PG \
  --rule-name dev --start-ip-address $MEU_IP --end-ip-address $MEU_IP
DATABASE_URL="$DB" npm run db:seed        # demo; o cliente real usa o script de §7.2
```

**Domínio no Route 53.**

```bash
FQDN=$(az containerapp show -g $RG -n sdr-app --query properties.configuration.ingress.fqdn -o tsv)
VERIFY=$(az containerapp env show -g $RG -n $ENV --query properties.customDomainConfiguration.customDomainVerificationId -o tsv)
# Route 53: CNAME app.<domínio> → $FQDN   e   TXT asuid.app.<domínio> → $VERIFY
az containerapp hostname add  -g $RG -n sdr-app --hostname app.<domínio>
az containerapp hostname bind -g $RG -n sdr-app --hostname app.<domínio> \
  --environment $ENV --validation-method CNAME     # certificado gerenciado, gratuito
```

Um subdomínio (`app.`) e não o domínio raiz: a raiz exigiria registro A e validação
HTTP.

### 8.3 Deploy contínuo (GitHub Actions)

Um workflow em `.github/workflows/deploy.yml`, disparado por push no ramo de deploy:

1. `azure/login` com OIDC (credencial federada numa *app registration*, papel
   `Contributor` no grupo de recursos e `AcrPush` no registro). Sem segredo de longa
   duração no GitHub.
2. `docker build --target runner` e push para o ACR com a tag do commit.
3. `az containerapp job update -n sdr-migrate --image …:$TAG`, depois `job start`, e
   espera a execução terminar em `Succeeded`. Se falhar, o workflow para aqui, e a
   aplicação continua na versão anterior.
4. `az containerapp update -n sdr-app --image …:$TAG` e
   `az containerapp job update -n sdr-sweep --image …:$TAG`.

Uma armadilha de ordem: uma migration que remove coluna quebra a versão anterior,
que ainda está no ar entre os passos 3 e 4. Para duas imobiliárias sem SLA, alguns
segundos de erro são aceitáveis. Vale saber que existem.

### 8.4 Desligar para não gastar crédito

| Situação | Ação | Fica pagando |
|---|---|---|
| Ninguém usando | Nada: a aplicação escala a zero sozinha | Postgres + ACR, ~US$ 21 |
| Pausa de semanas | `az postgres flexible-server stop`. O job de varredura falha a cada 15 min sem custo relevante. A Azure religa o Postgres em 7 dias | ~US$ 9 |
| Encerrar | `pg_dump` e `az group delete -n $RG` | nada |

---

## 9. O que pode exigir rodar a aplicação localmente

Nada bloqueia a decisão: o encanamento foi exercitado aqui (§2). Antes da primeira
implantação, vale fazer na máquina local, com chaves reais:

1. Subir a imagem `runner` (com `--platform linux/amd64` se for medir a imagem que
   vai para a Azure) com `MODEL_PROFILE=azure_nano` e uma conversa completa, para
   confirmar que o build de produção se comporta como o `npm run dev` com o modelo
   de verdade.
2. Rodar `npm run test:integration` e `npm run eval` antes do primeiro deploy, como
   já exige o fluxo de merge.

E, na primeira implantação, os três pontos que só a Azure responde: tempo de
partida a frio, o corte de 240 s sobre o SSE (§4.3) e a conexão TLS ao Postgres (§6).

---

## Fontes

- Preços: API de varejo da Azure, `https://prices.azure.com/api/retail/prices`,
  consultada em 10/10/2026 (East US 2 e Brazil South).
- [Ingress no Azure Container Apps](https://learn.microsoft.com/azure/container-apps/ingress-overview):
  timeout de 240 s, HTTP/2, afinidade de sessão.
- [Preços do Azure Container Apps](https://azure.microsoft.com/pricing/details/container-apps/):
  cota gratuita mensal, escala a zero sem cobrança, tarifa ociosa e seus limiares
  (0,01 vCPU, 1.000 bytes/s), jobs cobrados só durante a execução.
- [Jobs do Azure Container Apps](https://github.com/MicrosoftDocs/azure-docs/blob/main/articles/container-apps/jobs.md):
  gatilhos manual e agendado, `replicaTimeout`, `parallelism`.
- [Postgres Flexible Server na conta gratuita](https://learn.microsoft.com/azure/postgresql/flexible-server/how-to-deploy-on-azure-free-account):
  750 h de B1ms, 32 GB por 12 meses.
- [Opções de computação do Flexible Server](https://learn.microsoft.com/azure/postgresql/compute-storage/concepts-compute):
  parar e iniciar, religamento automático em 7 dias.
