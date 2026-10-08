# Restrições de implantação

Registro exigido pela constituição: **todo componente que não roda em contêiner
local — ou que roda com ressalva — precisa estar documentado aqui**, com o motivo,
o contorno adotado localmente e o caminho equivalente na nuvem.

A regra do projeto é `docker compose up` como única forma suportada de executar o
sistema. Cada entrada abaixo é uma exceção consciente a essa regra, não um
esquecimento.

---

## 1. oMLX — inferência local

**Status:** roda apenas no host. Não containerizável.

O oMLX é uma aplicação nativa de macOS construída sobre o MLX, que usa o Metal e a
memória unificada do Apple Silicon. Contêineres Linux não têm acesso ao Metal, então
**não existe forma de rodar o oMLX dentro do Docker** — nem nesta máquina, nem em
nenhuma outra.

### Contorno local

O contêiner acessa o servidor no host.

**a) A porta de escuta — resolvido em 31/08/2026.**

O registro anterior desta seção dizia que o oMLX escutava apenas em loopback
(`TCP 127.0.0.1:8990`), o que o tornava inalcançável por
`host.docker.internal`. A pergunta em aberto era se a versão instalada oferecia a
opção de mudar isso. **Oferece.** O aplicativo foi reconfigurado para escutar em
`0.0.0.0`, em todas as interfaces:

```console
$ lsof -nP -iTCP -sTCP:LISTEN | grep 8990
python3.1 ... TCP *:8990 (LISTEN)
```

O contêiner alcança o servidor diretamente em `http://host.docker.internal:8990/v1`.
Não é necessário encaminhar porta no host.

**Verificado de dentro do contêiner em 01/09/2026** (antes dos perfis de modelo;
hoje o modelo vem de `MODEL_PROFILE`). O item 1 do backlog fechou esta questão com
evidência, não com suposição:

```console
$ docker compose exec app npm run doctor
provider: http://host.docker.internal:8990/v1/models
model:    gemma4:12b
```

O contêiner recebeu resposta HTTP do servidor no host — a rota funciona. O
diagnóstico distingue três resultados: alcançável, falha de autenticação e
inalcançável, de modo que uma chave errada nunca é confundida com um problema de
rede. A verificação é sob demanda (`npm run doctor`), deliberadamente **fora** do
*readiness*: o provedor indisponível não torna a aplicação incapaz de servir
tráfego, e reprovar o *readiness* por causa dele tiraria de rotação um contêiner
saudável.

**Contingência.** Isto é uma preferência do aplicativo, não uma propriedade dele:
uma reinstalação ou uma atualização pode reverter para loopback. Se acontecer, o
sintoma é falha de conexão a partir do contêiner enquanto `curl` no host funciona
normalmente. Duas saídas, em ordem de preferência:

1. Reconfigurar a preferência de escuta no aplicativo — é onde ela deveria estar
2. Encaminhar a porta no host:
   ```bash
   socat TCP-LISTEN:8991,fork,reuseaddr TCP:127.0.0.1:8990
   ```
   e apontar o `base_url` dos perfis `omlx_*` (em `config/models/`) para
   `http://host.docker.internal:8991/v1`

Um provedor hospedado continua sendo a terceira saída, e não é um contorno — é o
mesmo caminho da nuvem, descrito abaixo.

**b) O endpoint exige chave de API.**

```console
$ curl -s http://localhost:8990/v1/models
{"error":{"message":"API key required","type":"authentication_error"}}
```

Verificado novamente em 31/08/2026: continua valendo. `OMLX_API_KEY` não é
placeholder — precisa do valor configurado no oMLX, mesmo sendo um servidor local.
É o único valor que um clone limpo não consegue preencher sozinho.

### Caminho na nuvem

Trocar `MODEL_PROFILE` para um perfil de qualquer endpoint compatível com
OpenAI (um arquivo YAML em `config/models/`). **Nenhuma linha de código muda** —
é exatamente o que o princípio VI da constituição garante (emendado em
08/10/2026, ADR 23).

**Demonstração (decidido em 05/09/2026, ADR 16; perfis em 08/10/2026, ADR 23):**
modelo hospedado na Azure OpenAI, pelo endpoint compatível
`https://<recurso>.openai.azure.com/openai/v1`, com os perfis `azure_nano`
(gpt-5.4-nano) ou `azure_luna_none` (gpt-6-luna, sem raciocínio). O endpoint e a
chave ficam no `.env` (`AZURE_OPENAI_BASE_URL`, `AZURE_OPENAI_API_KEY`); o
cabeçalho `api-key` fica no perfil. Validar manualmente antes de apresentar. Os
testes rodam fixados no perfil `omlx_gemma4_e4b` (a suíte comum usa um modelo
roteirizado e não chama modelo nenhum; só `npm run eval` fala com o modelo real).

---

## 2. Capacidade dos modelos locais

**Status:** roda, com ressalva de qualidade.

Os modelos locais testados (`gemma-4-e4b`, com e sem *thinking*, e `gemma-4-12B`,
que só serve para decidir se uma falha é do modelo ou do código) variam bastante
em confiabilidade de *tool calling* multi-turno em português. Modelos quantizados em
4 bits erram argumentos de função, repetem perguntas já respondidas e às vezes
abandonam o formato estruturado no meio da conversa.

**Mitigações, já embutidas na arquitetura:**

- Princípio V — a slot machine é determinística. O modelo extrai; quem decide o que
  perguntar é código. Um modelo esquecido não quebra a qualificação.
- Princípio VI — trocar para um modelo hospedado na demonstração custa trocar
  `MODEL_PROFILE` e preencher os segredos do provedor no `.env`.
- O modelo é usado só em três pontos do turno (extrair, agir por ferramentas,
  redigir), e tudo que precisa ser exato — datas, recusas, avisos — o código
  escreve. Ver [`turno-do-agente.md`](turno-do-agente.md).

**Consequência prática:** desenvolver com modelo local e **validar a demonstração
com o modelo que será usado nela**. Não assumir que a qualidade se transfere.

---

## 3. Servidor de desenvolvimento Next.js dentro do Docker no macOS

**Status:** roda, com custo de ergonomia.

O *file watching* sobre bind mounts do Docker Desktop no macOS é lento e pode
perder eventos, o que se traduz em hot reload que não dispara.

**Contorno:**

- `node_modules` e `.next` em **volumes nomeados**, nunca em bind mount — além do
  watching, evita conflito entre binários compilados no host e no contêiner
- Se o reload continuar falhando, habilitar polling
  (`WATCHPACK_POLLING=true`), aceitando o custo de CPU

Este é o único ponto em que a regra de Docker-first cobra preço real de
desenvolvimento.

**Consequência para a entrega:** o `docker compose up` sobe a aplicação e o worker
com o alvo `dev` do `Dockerfile` (`npm run dev`, código por bind mount). É o que
roda hoje, inclusive na demonstração. O alvo `runner` (`next build` + `next start`)
existe, mas o Compose não o usa; ver §7.

---

## 4. Langfuse self-hosted

**Status:** containerizável, com teto de memória. **Decidido em 05/09/2026** (ADR 13).

A stack oficial do Langfuse v3 tem seis serviços: web, worker, Postgres,
ClickHouse, Redis e MinIO, com recomendação de ~16 GiB. A VM do Docker nesta
máquina tem 7,7 GiB e ainda precisa acomodar `app`, `worker` e `db`.

**Contorno adotado:**

- Profile do Compose, desligado por padrão: `docker compose --profile observability up`
- O Postgres do Langfuse é um **segundo banco no contêiner `db` já existente**
  (`langfuse`), criado por script de inicialização — um contêiner a menos
- Limites de memória por serviço (`mem_limit`) somando **≤ 6 GiB**: ClickHouse é
  o maior e é configurado com `max_server_memory_usage` e sem cache de marcas
  grande; web e worker do Langfuse com `NODE_OPTIONS=--max-old-space-size`
  contido; Redis com `maxmemory`; MinIO no mínimo
- Latência de consulta na interface do Langfuse é irrelevante; o que importa é
  ingestão sem perda, garantida pelo exportador OTel em lote

Esses cinco contêineres (`clickhouse`, `redis`, `minio`, `langfuse-web`,
`langfuse-worker`) pertencem **só** ao perfil `observability`. A aplicação não usa
Redis: o trabalho assíncrono dela é `followup_jobs` e `events` no Postgres.

A aplicação funciona normalmente com o Langfuse ausente — princípio VII; sem as
três chaves `LANGFUSE_*` o rastreamento é um no-op. Os valores concretos dos
limites vivem no `docker-compose.yml`. Se o teto se mostrar apertado, Langfuse
Cloud é a saída: só as variáveis `LANGFUSE_*` mudam.

**Medido em 09/09/2026** (spec 004, T053), com o profile no ar e uma conversa
completa gravada, via `docker stats --no-stream`:

| Serviço | `mem_limit` | Uso medido |
|---|---|---|
| `clickhouse` | 2048 MiB | 1143 MiB |
| `langfuse-web` | 1536 MiB | 978 MiB |
| `langfuse-worker` | 1200 MiB | 373 MiB |
| `minio` | 512 MiB | 86 MiB |
| `redis` | 256 MiB | 15 MiB |
| **Total do profile** | **5552 MiB (5,42 GiB)** | **2594 MiB (2,53 GiB)** |

Os limites declarados somam 5552 MiB, abaixo do teto de 6 GiB do ADR 13, e o
uso real fica em menos da metade disso. Com `app`, `worker` e `db` somados, o
sistema inteiro com observabilidade ligada ocupa **3,26 GiB** dos 7,65 GiB da
VM — SC-012 satisfeito com folga.

Dois números foram descobertos por tentativa, não estimados: `langfuse-web`
morre com *"Ineffective mark-compacts near heap limit"* abaixo de 1536 MiB, e o
ClickHouse dimensiona os próprios caches pela memória do **host**, ignorando o
`mem_limit`, até ser morto pelo cgroup — daí o `scripts/clickhouse/low-memory.xml`.

---

## 5. Webhook do Telegram

**Status:** *não implementado.* Restrição registrada por antecipação; não há
adapter nem rota de webhook no código (o tipo `Channel` reserva o valor
`"telegram"` e nada mais).

A Bot API do Telegram entrega mensagens por webhook, o que exige **URL pública com
HTTPS** — indisponível para um serviço em `localhost`.

**Contorno local:** modo *long polling*, em que o processo consulta a API em vez de
receber chamadas, ou um túnel público. A interface do `ChannelAdapter` é idêntica
nos dois modos; muda apenas como as mensagens chegam até ela.

**Na nuvem:** webhook de verdade, sem contorno.

Registrado porque **molda a interface do adapter**, ainda que a implementação
nunca tenha sido feita (item 13 do backlog, abaixo da linha de corte).

---

## 6. WhatsApp Cloud API

**Status:** *não implementado.* Só o widget web existe.

A investigação de 27/09/2026 (item 32 do backlog) reavaliou a restrição original:
a API oficial da Meta, com o **número de teste**, dispensa verificação de negócio e
não custa nada no volume de uma demonstração (até 5 telefones cadastrados). Exigiria
um webhook público (túnel com domínio fixo, um passo só do host), e o maior risco
seria a janela de 24 horas para follow-up fora de uma conversa recente. A estimativa
foi de cerca de 1,5 dia; ficou abaixo da linha de corte e não foi construído.
Alternativas não oficiais (Evolution API, Baileys) violam os termos da Meta e
expõem a risco de banimento; não são opção.

**O que entregamos no lugar:** a interface `ChannelAdapter` (`src/channels/types.ts`)
e uma implementação, a do widget web. O argumento de arquitetura é que o WhatsApp
é *uma implementação* a mais — uma classe e a rota do transporte —, não uma
reescrita. É um argumento de desenho, não de funcionalidade entregue.

---

## 7. Implantação em nuvem

**Status:** *não feita.*

O sistema roda localmente, em `docker compose up`, e só. Não há ambiente na nuvem,
pipeline de CI/CD nem imagem publicada. O caminho previsto é levar os mesmos
contêineres (`app` e `worker`, uma imagem, dois comandos) a um runtime gerenciado
com Postgres gerenciado, usando o alvo `runner` do `Dockerfile`; o provedor de
modelo já é hospedado por configuração. Esse caminho **nunca foi exercitado**: o
alvo `runner` existe para que a afirmação "os mesmos contêineres rodam na nuvem"
seja testável, mas não foi implantado em lugar algum. Detalhes de escala em
[`visao-geral.md`](visao-geral.md) §4 e §7.

---

## Como usar este registro

Ao planejar uma mudança que dependa de qualquer componente acima, **leia a entrada
correspondente antes de planejar**. Ao descobrir uma nova restrição durante a
implementação, acrescente uma entrada aqui no mesmo commit — o registro só tem
valor se estiver completo.
