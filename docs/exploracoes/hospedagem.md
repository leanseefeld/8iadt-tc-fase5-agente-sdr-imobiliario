# Exploração: hospedagem (Azure ou VPS)

> **Status (13/10/2026): exploração, nada implantado.** Nenhum recurso foi criado na
> Azure nem numa VPS. O que mudou no código foi a imagem de produção (§3), que ficou
> menor e passou a sair em amd64 e arm64, construída pelo GitHub Actions. O registro de
> [`restricoes-de-implantacao.md`](../arquitetura/restricoes-de-implantacao.md) §7
> continua verdadeiro: não há ambiente na nuvem.

> **Não normativo.** Avalia uma proposta de arquitetura recebida pelo desenvolvedor
> ("AI SDR — Cloud Architecture Proposal": App Service + Function Timer + Postgres
> gerenciado + Azure OpenAI + Key Vault + ACR, com o domínio no Route 53), compara com
> uma VPS barata, e registra o que foi medido. A escolha final vira ADR quando for feita.

**Objetivo declarado:** o caminho mais curto para hospedar o sistema e ter o primeiro
cliente rodando, até duas imobiliárias. Sem SLA, sem cadastro nem cobrança. Na Azure,
não gastar crédito quando nada estiver rodando. Alternativa: uma VPS abaixo de
R$ 50/mês, ligada o tempo todo.

**Fora do escopo:** cadastrar uma imobiliária nova. Hoje só existe a `demo`, criada
pelo seed; um fluxo de *onboarding* de verdade será desenhado quando houver o segundo
cliente. Incorporar o widget no site da imobiliária tem a sua própria exploração:
[`widget-embutido.md`](widget-embutido.md).

---

## 1. Resposta curta

As três opções são viáveis sem mudar a arquitetura. A imagem de produção foi
reconstruída para levar só o que roda, em amd64 e arm64 (§3), e exercitada nos dois
formatos de implantação. O endereço será `https://sofia.nomadmacaw.com`, num domínio
que já está no Route 53.

| | Azure Container Apps | VM na Azure (Docker Compose) | VPS no Brasil (Docker Compose) |
|---|---|---|---|
| Custo por mês | ~US$ 27–33, pago com crédito (§4.4) | **~US$ 12–13**, pago com crédito (§6); ~US$ 6 na conta gratuita | R$ 30–45, pago em reais (§5.2) |
| Parada quando ninguém usa | o app escala a zero; worker e banco ficam ligados | não; `deallocate` para de cobrar a VM | não, e não precisa |
| Partida a frio | sim, segundos (imagem de 68 MB) | não | não |
| SSE | corte a cada 240 s, reconexão invisível (§4.3) | sem corte | sem corte |
| Worker | Container App sempre ligado (§4.1) | o processo de hoje | o processo de hoje |
| Banco | gerenciado, com backup | nosso, backup por cron | nosso, backup por cron |
| Mudança de código para subir | nenhuma | nenhuma | nenhuma |
| Pronto no repositório | não, roteiro em §4.5 | `deploy/vps/` (Compose + Caddy + roteiro `az vm`) | `deploy/vps/` |

**Recomendação:**
- **Primeiro mês, com os créditos: a VM na Azure.** É a pilha de `deploy/vps/`
  numa B2pts v2 (arm64) ou B2ats v2 (amd64). Custa menos da metade do Container Apps,
  fica sempre quente e não tem o corte de 240 s.
- **Depois dos créditos, ou para um cliente pagando em reais: a VPS no Brasil.**
  Mesma pilha, mesmo `.env`. A mudança é um `pg_dump`, o IP no Route 53 e um
  `docker compose up`.
- **O Container Apps** só se justifica se um contrato pedir banco gerenciado, ou
  muitas réplicas.

---

## 2. A proposta original contra o código

Pontos em que a proposta presume algo diferente do que o código faz, válidos para os
dois destinos:

1. **"Adicionar Redis Pub/Sub se houver mais de uma instância."** Não é necessário. O
   SSE já usa `LISTEN/NOTIFY` do Postgres, com uma conexão por réplica
   ([`visao-geral.md`](../arquitetura/visao-geral.md) §9, `core/notifier.ts`). Um evento
   gravado por qualquer réplica, ou pelo worker, chega aos streams de todas. Redis também
   contraria a regra "No Redis" do `AGENTS.md`. **Consequência prática:** a
   `DATABASE_URL` precisa apontar para uma conexão direta com o Postgres, nunca para um
   pool em modo transação (como o PgBouncer embutido do Flexible Server, porta 6432),
   porque `LISTEN` não sobrevive a ele.
2. **"Webhook do WhatsApp no mesmo app."** O WhatsApp **não está implementado**
   ([`restricoes-de-implantacao.md`](../arquitetura/restricoes-de-implantacao.md) §6). A
   hospedagem não depende dele. O que ela muda é que passa a existir uma URL pública com
   HTTPS, que era o bloqueio citado no registro.
3. **"Proteger contra varreduras sobrepostas."** Já está protegido. Os consumidores
   reivindicam linhas com `FOR UPDATE SKIP LOCKED`, o turno é guardado por `claimTurn`,
   e há teste de integração com dois *claimers* (`tests/followup-claim.test.ts`).
4. **Rota interna `POST /api/internal/worker/sweep` acionada por Function Timer.**
   Desde a spec 017, o worker não é só um timer: ele mantém um `LISTEN followup_due`
   (`src/worker/wake.ts`) e varre na hora quando alguém usa *Enviar agora* na fila de
   follow-ups. Qualquer agendamento externo, seja Function ou job, perde isso: o botão
   esperaria até 15 minutos. Nos dois destinos, o worker continua sendo o processo de
   hoje, sempre ligado.
5. **Key Vault.** Os *secrets* do Container Apps, ou o `.env` com `chmod 600` na VPS,
   bastam para duas imobiliárias.

---

## 3. A imagem de produção

**Antes (10/10/2026):** o alvo `runner` copiava o repositório inteiro, `node_modules`
completo (dependências de desenvolvimento incluídas, os binários do SWC para glibc
*e* musl, o `sharp`) e o cache de build do Next. Ficava com **479 MB comprimida, 1,6 GB
descompactada**.

**Agora (11/10/2026), no `Dockerfile`:**

- o app sai do **`output: "standalone"`** do Next. É o `server.js` mais um
  `node_modules` podado pelo *trace* do próprio Next (33 pacotes, 21 MB). O `sharp`
  fica de fora (`outputFileTracingExcludes`): ele só serve ao `next/image`, que o
  projeto não usa;
- o worker, o migrate e o seed são **empacotados com esbuild** (`npm run build:jobs`,
  `dist/`). São três arquivos com as dependências dentro, 7 MB no total, que não
  precisam de `node_modules`;
- a imagem final só leva o que é lido em tempo de execução: o *standalone*,
  `.next/static`, `dist/`, `config/models/`, as migrations (aplicadas pelo migrate e
  comparadas pelo *readiness*) e o catálogo do seed. Roda como o usuário `node`.

**Cache:** o `npm ci` fica num estágio que só depende de `package.json` e
`package-lock.json`, com o cache do npm montado (`--mount=type=cache`). O
`.next/cache` também é um *cache mount*: acelera o build incremental sem entrar em
nenhuma camada. As camadas da imagem final vão da que menos muda (configuração,
migrations) para a que mais muda (o código compilado).

| Medida | Antes | Depois |
|---|---|---|
| Imagem comprimida (o que se baixa) | 479 MB | **68 MB** (62 MB são a própria `node:24-alpine`) |
| Imagem descompactada | 1,6 GB | 288 MB |
| Memória do app em repouso | 246 MiB | 60–74 MiB |
| Memória do worker em repouso | 186 MiB | 42–45 MiB |
| Rebuild depois de mudar só código | — | 22 s; `npm ci` reaproveitado do cache; 8 de 11 camadas idênticas |

**O que foi exercitado na imagem nova:**
- `node dist/db/migrate.js` aplica as 4 migrations, e `node dist/db/seed/index.js` semeia;
- o app sobe com o *readiness* verde (banco e migrations), serve os *assets*, e um
  corretor entra pelo `/login` (Playwright) e vê `/leads`;
- uma conversa chega por SSE (`pulse`, `chunk`, `message`);
- `node dist/worker/index.js` roda os três consumidores, com e sem o Langfuse (que
  importa o OpenTelemetry dinamicamente). Ele também refez um turno que o app deixou
  sem resposta (app derrubado dentro do debounce): extração, chamada ao modelo,
  *fallback* e `commit`. Esse é o caminho inteiro do agente empacotado;
- `npm test` passa no Node 24 (288 testes, 0 falhas), e o `npm run lint` também.
  A suíte de integração não foi rodada: ela usa o alvo `dev`, que não mudou.

**Comandos:** o padrão da imagem sobe o app (`node server.js`, porta `APP_PORT`). O
worker é `node dist/worker/index.js`, o migrate `node dist/db/migrate.js` e o seed
`node dist/db/seed/index.js`. O alvo `dev` e o Compose de desenvolvimento não mudaram
de comportamento.

**amd64 e arm64 (13/10/2026).** O `npm ci` e o build rodam na plataforma de quem
constrói (`FROM --platform=$BUILDPLATFORM`), e só o estágio final usa a `node:24-alpine`
da arquitetura de destino. Isso funciona porque o que vai para a imagem é JavaScript
puro: nenhum `.node` ou `.so` em `/app`, verificado. A imagem arm64 é o build amd64
copiado sobre o Node arm64, sem `npm ci` nem `next build` emulados. Construída aqui em
23 s com o cache quente, com o mesmo tamanho (68 MB), e exercitada sob QEMU na pilha
de `deploy/vps/`: migrate, seed, login, conversa por SSE e a campainha do worker.

**No GitHub Actions:** `.github/workflows/image.yml` constrói as duas arquiteturas num
runner amd64 comum, em todo PR (sem publicar) e a cada push no `main` (publicando
`ghcr.io/leanseefeld/8iadt-tc-fase5-agente-sdr-imobiliario:latest` e `:sha-<curto>`). O
repositório é público, então os minutos do Actions e o pacote público no GHCR não
custam nada. Os runners arm64 nativos (`ubuntu-24.04-arm`) também são gratuitos para
repositórios públicos, mas não são necessários com esse Dockerfile.

---

## 4. Azure

### 4.1 Recomendado no lugar da proposta

| Proposta | Recomendado | Por quê |
|---|---|---|
| App Service (Docker) | **Container Apps**, plano Consumption, `min-replicas 0` | O App Service cobra o plano 24 h por dia, mesmo parado. O Container Apps escala a zero e não cobra nada nesse estado |
| Function Timer → `POST /api/internal/worker/sweep` | **Worker como um segundo Container App**, sem ingress, `min = max = 1`, 0,25 vCPU / 0,5 GiB, com `node dist/worker/index.js` | O ping HTTP a cada 15 min **acorda a aplicação** e a mantém ativa pelo *cooldown* (300 s), cerca de um terço do dia. E o worker precisa ficar ligado para ouvir o *Enviar agora* (§2.4). Ligado, ele custa ~US$ 6/mês em tarifa ociosa e não exige nenhuma mudança de código. Um job agendado custaria quase nada, mas perderia a campainha |
| Migrations rodando no GitHub Actions | **Job manual** com `node dist/db/migrate.js` | O runner do GitHub tem IP variável e não alcança um Postgres com firewall. O job roda dentro da Azure |
| Key Vault | *Secrets* do próprio Container Apps | Chegam como variável de ambiente, que é o que `core/config.ts` lê |

O resto da proposta se mantém: Postgres Flexible Server (B1ms), Azure OpenAI pelo
perfil `azure_*`, ACR Basic, Langfuse Cloud e o domínio no Route 53.

```text
 Route 53 (CNAME app.<domínio>) → Container Apps Environment (Consumption)
     sdr-app      ingress externo, porta 3100, min 0 / max 1, 0,25 vCPU / 0,5 GiB
     sdr-worker   sem ingress, min 1 / max 1, node dist/worker/index.js
     sdr-migrate  job manual, node dist/db/migrate.js
         │ SQL + LISTEN/NOTIFY (5432, TLS)          │ HTTPS
         ▼                                          ▼
 Postgres Flexible Server B1ms               Azure OpenAI · Langfuse Cloud
```

O tamanho **0,25 vCPU / 0,5 GiB** passou a caber com a imagem nova: o app usa ~70 MiB
em repouso. É a menor combinação do Container Apps, e metade do custo de 0,5 / 1 GiB.

### 4.2 Escalar a zero, na prática

- **Partida a frio.** Depois de 300 s sem requisição, a réplica sai. A próxima baixa a
  imagem (68 MB, se o nó não tiver cache) e sobe o servidor (~3 s medidos depois do
  download). A espera precisa ser medida na Azure; a estimativa é de alguns segundos a
  algumas dezenas. Para um lead abrindo o widget, isso pesa. A saída é
  `min-replicas 1` (§4.4).
- **Streams abertos mantêm a réplica viva.** Um SSE aberto é uma requisição em
  andamento. Uma aba de `/leads` esquecida aberta mantém a aplicação em tarifa ativa
  (pior caso em §4.4).
- **O debounce do turno é seguro.** O `POST` que arma o timer é uma requisição, e o
  widget mantém o SSE aberto. Se a réplica sair mesmo assim, `unanswered-turns` refaz o
  turno na próxima varredura (comportamento verificado em §3).
- **O worker não depende da aplicação.** Ele grava e dá o `NOTIFY`. Se houver widget
  aberto, a réplica do app está de pé e entrega. O *Enviar agora* faz o caminho
  contrário: o app dá o `NOTIFY` e o worker, sempre ligado, acorda.

### 4.3 O corte de 240 s do ingress

A documentação do Container Apps fixa *"Request time out is 240 seconds"* no ingress
HTTP. O mais provável é que um SSE seja encerrado aos 4 minutos, mesmo com o `pulse`
a cada 15 s. Pela leitura do código, o efeito é invisível. A rota manda `retry: 3000`,
e o `EventSource` reconecta em 3 s. O `readyState` fica `CONNECTING`, e não `CLOSED`,
então o widget não mostra "Conexão perdida". As mensagens gravadas no intervalo voltam
por `Last-Event-ID`. **A verificar na primeira implantação.** Numa VPS com Caddy, não
há corte.

### 4.4 Custos

Preços de tabela em USD da API de varejo da Azure (`prices.azure.com`), consultada em
10/10/2026, East US 2, mês de 730 h.

| Recurso | East US 2 | Brazil South |
|---|---|---|
| Postgres Flexible B1ms, 24 h | 12,41 | 25,55 |
| Armazenamento do Postgres, 32 GB | 3,68 | 6,99 |
| ACR Basic | 5,07 | 5,07 |
| Container Apps, vCPU ativa / ociosa | US$ 0,000024 / 0,000003 por s | igual |
| Container Apps, memória (ativa ou ociosa) | US$ 0,000003 por GiB·s | igual |
| Cota gratuita mensal do Container Apps | 180.000 vCPU·s, 360.000 GiB·s | igual |

**Cenários (East US 2, app e worker em 0,25 vCPU / 0,5 GiB cada):**

| Cenário | Mês |
|---|---|
| Parado: app escalando a zero, worker ligado | **~US$ 27**: Postgres 16,09 + ACR 5,07 + worker ocioso ~5,90 |
| Uso real: duas imobiliárias, painel aberto 10 h × 22 dias | **~US$ 28**: o uso ativo do app passa da cota em ~US$ 1 |
| Sempre quente (app com `min-replicas 1`), sem partida a frio | **~US$ 33**: os de cima **mais** ~US$ 6 de tarifa ociosa do app |
| Pior caso: uma aba de `/leads` aberta 24 h por dia | ~US$ 41 (o app ativo o mês inteiro, ~US$ 14 depois da cota) |
| "Hibernado": Postgres parado, worker com `min-replicas 0` | ~US$ 9. A Azure religa o Postgres sozinha em 7 dias |
| *A proposta original* (App Service B1 + Function + ACR + Postgres) | ~US$ 34 fixos, usando ou não |

**Sobre o "manter quente":** sim, é **somado** à estimativa base. A primeira versão
desta exploração dizia ~US$ 12 por mês porque considerava o app com 0,5 vCPU e 1 GiB
(US$ 0,0000045 por segundo ocioso × 2.628.000 s). Com a imagem nova, 0,25 vCPU / 0,5 GiB
basta, e a tarifa ociosa cai para ~US$ 5,90 (US$ 0,00000225 por segundo). O worker
paga a mesma tarifa, porque fica sempre ligado. Não confirmei se a cota gratuita também
desconta segundos ociosos; os números acima não a aplicam. Com ela, o custo do
Container Apps cai, e o que sobra é Postgres e ACR.

**Duas alavancas:**

1. **Conta gratuita da Azure.** Nos primeiros 12 meses de uma conta gratuita, a Azure
   inclui 750 h/mês de Postgres Flexible B1ms, 32 GB de armazenamento e 32 GB de backup.
   Isso tira ~US$ 16 de todos os cenários. Vale conferir se a assinatura dos créditos é
   desse tipo. Não confirmei se a assinatura Azure for Students inclui o benefício.
2. **Região.** O Container Apps custa o mesmo nas duas regiões. O Postgres no Brazil
   South custa o dobro (+~US$ 16,50). Para a POC, a sugestão é a região do recurso Azure
   OpenAI que já existe.

**Armadilha:** o ambiente precisa ser só Consumption. Um *workload profile* dedicado
liga o medidor "Environment Management Hour" (US$ 0,10/h, ~US$ 73/mês).

### 4.5 Roteiro (não executado)

> Comandos escritos contra a documentação da CLI `az` (`az extension add -n containerapp`),
> não testados nesta assinatura. Conferir cada um no primeiro uso.

```bash
RG=sdr-poc; LOC=eastus2; ENV=sdr-poc-env
ACR=sdrpoc$RANDOM; PG=sdr-poc-pg-$RANDOM
az group create -n $RG -l $LOC
az acr create -g $RG -n $ACR --sku Basic
az postgres flexible-server create -g $RG -n $PG -l $LOC \
  --tier Burstable --sku-name Standard_B1ms --storage-size 32 --version 17 \
  --admin-user sdradmin --admin-password "$PG_PASSWORD" \
  --public-access 0.0.0.0 --database-name sdr          # 0.0.0.0 = serviços da Azure
az containerapp env create -g $RG -n $ENV -l $LOC       # Consumption

TAG=$(git rev-parse --short HEAD)
docker build --platform linux/amd64 --target runner -t $ACR.azurecr.io/sdr:$TAG .
az acr login -n $ACR && docker push $ACR.azurecr.io/sdr:$TAG

DB="postgresql://sdradmin:$PG_PASSWORD@$PG.postgres.database.azure.com:5432/sdr?sslmode=verify-full"
SECRETS="database-url=$DB auth-secret=$AUTH_SECRET aoai-key=$AZURE_OPENAI_API_KEY"
ENVV="NODE_ENV=production APP_PORT=3100 MODEL_PROFILE=azure_nano \
  DATABASE_URL=secretref:database-url AUTH_SECRET=secretref:auth-secret \
  AZURE_OPENAI_BASE_URL=$AZURE_OPENAI_BASE_URL AZURE_OPENAI_API_KEY=secretref:aoai-key"
IMG="--image $ACR.azurecr.io/sdr:$TAG --registry-server $ACR.azurecr.io --registry-identity system"

az containerapp job create -g $RG -n sdr-migrate --environment $ENV $IMG \
  --trigger-type Manual --replica-timeout 300 --replica-retry-limit 0 \
  --parallelism 1 --replica-completion-count 1 --cpu 0.25 --memory 0.5Gi \
  --command "node" --args "dist/db/migrate.js" --secrets $SECRETS --env-vars $ENVV
az containerapp job start -g $RG -n sdr-migrate

az containerapp create -g $RG -n sdr-app --environment $ENV $IMG \
  --ingress external --target-port 3100 \
  --cpu 0.25 --memory 0.5Gi --min-replicas 0 --max-replicas 1 \
  --secrets $SECRETS --env-vars $ENVV

# Worker: sem ingress, sempre uma réplica (ouve o *Enviar agora*).
az containerapp create -g $RG -n sdr-worker --environment $ENV $IMG \
  --cpu 0.25 --memory 0.5Gi --min-replicas 1 --max-replicas 1 \
  --command "node" --args "dist/worker/index.js" \
  --secrets $SECRETS --env-vars $ENVV
```

- **`sslmode=verify-full`, explícito:** o `pg` 8.23 já trata `require` como
  `verify-full`, mas emite um aviso de segurança.
- **Domínio:** no Route 53, um CNAME `sofia.nomadmacaw.com` para o FQDN do app, e um
  TXT `asuid.sofia.nomadmacaw.com` com o `customDomainVerificationId` do ambiente. Depois
  `az containerapp hostname add` e `bind --validation-method CNAME` emitem o
  certificado gerenciado, que é gratuito.
- **Deploy contínuo:** GitHub Actions com `azure/login` por OIDC → build e push para o
  ACR → atualizar e disparar `sdr-migrate`, e esperar `Succeeded` → atualizar
  `sdr-app` e `sdr-worker`.
- **Orçamento com alerta** (Cost Management → Budgets): é o freio contra a aba esquecida.

---

## 5. VPS abaixo de R$ 50/mês

### 5.1 O que roda

[`deploy/vps/`](../../deploy/vps/) traz o `compose.yml`, o `Caddyfile` e um README com
a preparação do servidor, o deploy, o backup e o monitoramento. São os mesmos serviços
do desenvolvimento, todos da imagem `runner`: `db`, `migrate`, `app`, `worker`, mais o
`caddy` para o HTTPS.

**Exercitado localmente** com `DOMAIN=localhost` (certificado interno do Caddy). Os
quatro serviços subiram saudáveis, na ordem certa. Por HTTPS, através do Caddy, o SSE
chegou sem buffer: o `chunk` 3,7 s depois do `POST` (debounce de 3 s mais o turno) e um
`pulse` a cada 15 s. **A pilha inteira usa ~150 MiB em repouso** (Caddy 13, app 60,
worker 42, Postgres 38).

Consequências:
- **1 GB de RAM basta** para rodar. O build fica no CI, porque o `next build` não cabe
  com folga numa máquina dessas;
- **2 GB ou mais** dão espaço para o Postgres crescer, e para o Langfuse self-hosted
  numa máquina de 4 GB ou mais: ele mediu 2,5 GiB no perfil `observability`. Com 1–2 GB,
  usar o Langfuse Cloud;
- **nenhuma mudança de código:** o worker continua sendo o processo de hoje, com o
  timer e o *health check*.

### 5.2 Opções

Preços consultados em 11/10/2026 nas páginas dos provedores ou em comparativos,
conferir antes de contratar. Câmbio usado: US$ 1 ≈ R$ 5,15 e € 1 ≈ R$ 6,00.

| Provedor | Plano | Onde | Preço/mês | Observação |
|---|---|---|---|---|
| Hostinger | KVM 1: 1 vCPU, 4 GB, 50 GB NVMe | **São Paulo** disponível | R$ 29,99 promocional | Preço de contrato longo, pago adiantado; **renova a R$ 59,99**, acima do teto. O KVM 2 (2 vCPU, 8 GB) sai a R$ 43,99 promocional e renova a R$ 77,99 |
| Serverspace | 1 vCPU, 2 GB, 25 GB | São Paulo (Equinix SP3) | ~R$ 24 | Preço de comparativo, não da página do provedor |
| Vultr | 1 vCPU, 1 GB | **São Paulo** | a partir de US$ 5–6 (~R$ 26–31) | Por hora, sem contrato. O de 2 GB passa do teto |
| Hetzner | 2 vCPU, 4 GB (linha *cost-optimized*) | EUA (Ashburn) e Europa | ~€ 4,50 + IPv4 (~R$ 30) | Melhor RAM por real, mas longe (~120 ms até SP). Subiu de preço duas vezes em 2026, e a página mostrava os planos compartilhados como indisponíveis |
| Oracle Cloud Always Free | Ampere A1, até 2 OCPU / 12 GB (ARM) | São Paulo e Vinhedo | R$ 0 | Limite cortado em jun/2026. Capacidade difícil de conseguir, instância ociosa pode ser recolhida na conta gratuita, e exige imagem `linux/arm64` (`docker buildx --platform`) |
| Magalu Cloud | VM x86 | São Paulo | não obtido | Cobra em reais; a página de preços não carregou |

**Recomendação:** **Hostinger KVM 1 em São Paulo** se pagar o período longo
adiantado. Ele cabe folgado (4 GB), fica perto dos leads e custa ~R$ 30/mês enquanto
durar o contrato. Para pagar mês a mês sem compromisso, **Vultr São Paulo** com 1 GB,
ou Serverspace com 2 GB. A Oracle só serve para experimentar; o risco de a instância
sumir não combina com cliente.

### 5.3 O que a VPS cobra em operação

Nada disso existe na Azure gerenciada:
- **Backup:** `pg_dump` diário por cron, com cópia fora do servidor e uma restauração
  de teste (roteiro no README de `deploy/vps/`). É o item que não pode ser esquecido;
- **Atualizações:** `unattended-upgrades` para o sistema, `docker compose pull` para as
  imagens;
- **Segurança:** SSH só por chave, `ufw` com 22, 80 e 443, e o Postgres sem porta
  publicada;
- **Disco:** os logs do Docker com teto (`max-size` no `daemon.json`), que por padrão
  crescem sem limite;
- **Sem redundância:** se o servidor cair, o sistema cai. Sem SLA, é aceitável. O
  backup externo é o que garante voltar.

---

## 6. VM na Azure (a pilha de `deploy/vps/`)

A mesma pilha da VPS, numa máquina virtual paga com os créditos da Azure. O roteiro
(`az vm create`, NSG, swap, Route 53) está em [`deploy/vps/README.md`](../../deploy/vps/README.md).

**O menor tamanho que comporta:** 1 GiB e 2 vCPUs, mais 2 GB de swap. A pilha usa
~150 MiB em repouso (§5.1). O B1ls (0,5 GiB) é mais barato, mas não comporta Docker,
Postgres e Node com folga.

Um mês (730 h), Linux, preços da API de varejo da Azure em 13/10/2026:

| Item | East US 2, arm64 (B2pts v2) | East US 2, amd64 (B2ats v2) | Brazil South, amd64 (B2ats v2) |
|---|---|---|---|
| VM | 6,13 | 6,86 | 11,02 |
| Disco do sistema, Standard SSD 32 GiB (E4) | 2,40 | 2,40 | 4,48 |
| IPv4 público estático (Standard) | 3,65 | 3,65 | 3,65 |
| Tráfego de saída (100 GB/mês gratuitos) | ~0 | ~0 | ~0 |
| **Total** | **~US$ 12,20 (≈ R$ 63)** | **~US$ 12,90 (≈ R$ 66)** | **~US$ 19,15 (≈ R$ 99)** |

- **arm64 é a opção mais barata** e funciona sem mudança: a imagem é multi-arquitetura
  (§3), e o Postgres e o Caddy oficiais também têm variante arm64. O B2pts v2 não tem
  preço no Brazil South; fica no East US 2 ou noutra região que o ofereça.
- **Conta gratuita:** as 750 h/mês da conta gratuita (12 meses) cobrem B1s, B2pts v2 e
  B2ats v2. Sobram o disco e o IP, ~US$ 6. Não confirmei se o IP público entra em alguma
  franquia.
- **Fora da conta:** Langfuse Cloud (o plano Hobby é gratuito) e os tokens do Azure
  OpenAI, que custam o mesmo em qualquer destino. O backup em Blob Storage custa
  centavos.
- **Parar de pagar:** `az vm deallocate` para a cobrança da VM, mas o disco e o IP
  continuam (~US$ 6). `az group delete` apaga tudo; antes, faça o `pg_dump`.
- **Comparado com o Container Apps** (§4.4, US$ 27–33): menos da metade, porque não há
  Postgres gerenciado (US$ 16) nem ACR (US$ 5). O preço disso é o backup e as
  atualizações por nossa conta (§5.3), como na VPS.

**Domínio:** registro `A` de `sofia.nomadmacaw.com` para o IP estático da VM, no
Route 53. A porta 80 aberta no NSG, para a validação do Let's Encrypt, e o `.env` com
`DOMAIN=sofia.nomadmacaw.com`.

---

## 7. O que falta no código

**Para subir, nada, em nenhum dos destinos.** A primeira versão desta exploração
pedia um modo "uma varredura e sai" no worker, para rodá-lo como job agendado na Azure.
Com a campainha da spec 017 (§2.4), um job perderia o *Enviar agora*, e o worker passa a
ser um processo sempre ligado nos dois destinos, exatamente como no Compose.

**Exercitado depois do merge da spec 017 (11/10/2026),** na imagem nova e na pilha de
`deploy/vps/`: as 5 migrations, o seed, a gerente (`carla@demo.com.br`) em
`/configuracoes` e `/followups`, e a campainha do worker empacotado. Um
`pg_notify('followup_due', …)` disparou uma varredura completa em menos de meio segundo.

**Pequenos pontos:**
- `login` procura o usuário só pelo e-mail (`services/auth.ts`), mas a unicidade é por
  agência e e-mail. Com duas agências, basta não repetir e-mails;
- o CI só constrói a imagem (`.github/workflows/image.yml`); lint e testes ainda rodam
  à mão, e o deploy é manual (`docker compose pull && up -d` no servidor). Um passo de
  deploy por SSH no mesmo workflow é o próximo passo natural, quando houver servidor.

---

## Fontes

- Preços da Azure: API de varejo, `https://prices.azure.com/api/retail/prices`
  (10/10/2026, East US 2 e Brazil South).
- [Ingress no Azure Container Apps](https://learn.microsoft.com/azure/container-apps/ingress-overview):
  timeout de 240 s.
- [Preços do Azure Container Apps](https://azure.microsoft.com/pricing/details/container-apps/):
  cota gratuita, escala a zero, tarifa ociosa, jobs cobrados só durante a execução.
- [Jobs do Azure Container Apps](https://github.com/MicrosoftDocs/azure-docs/blob/main/articles/container-apps/jobs.md).
- [Postgres Flexible Server na conta gratuita](https://learn.microsoft.com/azure/postgresql/flexible-server/how-to-deploy-on-azure-free-account).
- [Opções de computação do Flexible Server](https://learn.microsoft.com/azure/postgresql/compute-storage/concepts-compute):
  parar e iniciar.
- [Hostinger VPS](https://www.hostinger.com/br/servidor-vps) e
  [data center no Brasil](https://www.hostinger.com/vps/servers/brazil).
- [Comparativo de VPS no Brasil, 2026](https://guiadohost.com/2026/05/12/vps-barato-no-brasil-2026-compare-6-planos-de-entrada-e-descubra-o-melhor-custo-beneficio/)
  (Serverspace, Vultr São Paulo).
- [Reajuste da Hetzner em 2026](https://agentdeals.dev/hetzner-pricing-2026).
- [Corte do Always Free da Oracle](https://infoq.com/news/2026/07/oracle-cloud-free-tier-limits/).
- [Máquinas virtuais na conta gratuita da Azure](https://azure.microsoft.com/en-us/free/virtual-machines):
  750 h de B1s, B2pts v2 e B2ats v2 por 12 meses.
- [Runners arm64 do GitHub Actions](https://github.blog/changelog/2025-08-07-arm64-hosted-runners-for-public-repositories-are-now-generally-available/):
  gratuitos em repositórios públicos.
- [Magalu Cloud: data centers em São Paulo e Fortaleza](https://www.baguete.com.br/noticias/magalu-cloud-levanta-r-300-milhoes-com-bndes).
