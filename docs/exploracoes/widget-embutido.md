# Exploração: o widget no site da imobiliária

> **Status (11/10/2026): exploração, nada implementado.** O código continua com o
> cookie do chat em `SameSite=Lax`. O widget funciona quando aberto pelo endereço
> dele (`/chat/<slug>`), e não funciona dentro de um `<iframe>` em outro domínio.

> **Não normativo.** Aberta a pedido do desenvolvedor junto com a
> [exploração de hospedagem](hospedagem.md). Registra a ideia de um SDK de
> incorporação com domínios autorizados pela própria imobiliária, e avalia
> WebSockets como alternativa ao SSE para esse caso.

## 1. O problema, medido

O stream do chat (`GET /api/chat/[conversationId]/events`) só confia no cookie
`chat_session`, nunca no id da URL (FR-047). O cookie é gravado pelo `POST /api/chat`
com `SameSite=Lax` (`core/auth.ts`, `chatSessionCookie`). Dentro de um `<iframe>` num
site de outro domínio, o navegador trata as requisições do widget como *cross-site*:
o cookie `Lax` não é gravado nem enviado.

Teste com Playwright (Chromium), em 11/10/2026. Uma página em `http://127.0.0.1:8080`
incorporava `https://localhost/chat/demo` (a pilha de `deploy/vps/`):

| | Aberto direto | Dentro do iframe, hoje | Dentro do iframe, cookie particionado |
|---|---|---|---|
| Cookie `chat_session` | gravado (`Lax`) | **nenhum** | gravado (`None`, particionado) |
| `GET /api/chat` (histórico) | 200 | 200 | 200 |
| `POST /api/chat` | 202 | 202 | 202 |
| `GET …/events` (SSE) | 200 | **401** | 200 |
| Resultado na tela | resposta da Sofia | **"Conexão perdida. Reconectando…"**, campo desabilitado | resposta da Sofia |

O SSE não é o problema; o cookie é. O lead consegue aceitar o consentimento (o `POST`
não precisa de sessão), mas nunca recebe a resposta e não consegue digitar.

## 2. O que a imobiliária configuraria

A ideia: na página de configurações do gerente comercial (`salesManager`), uma lista
de **domínios autorizados** a exibir o widget daquela agência, por exemplo
`https://www.imobiliariax.com.br`. Ela vale para qualquer uma das opções abaixo.

- **Guardado por agência:** uma coluna `allowedOrigins text[]` em `agencies`, ou
  numa tabela de configurações da agência, se a página nova já tiver uma.
  ([`configuracoes.md`](../arquitetura/configuracoes.md) registra o que é por agência.)
- **Validação:** só `https://`, só a origem (esquema + host + porta, sem caminho), e
  um número pequeno de entradas. A mudança vale na próxima requisição.
- **O que a lista garante, e o que não garante:** ela impede que *outro site* exiba o
  widget da agência num navegador. Ela **não é autenticação**: um script fora do
  navegador manda o `Origin` que quiser. Contra abuso automatizado continua valendo o
  orçamento de mensagens por sessão (`CHAT_MESSAGE_BUDGET`).

> A página de configurações citada pelo desenvolvedor não estava no `main` do GitHub
> em 11/10/2026. Esta seção supõe uma página por agência, só para o gerente. Ajustar
> quando ela for publicada.

## 3. Opções

### A. Iframe com cookie particionado, e um SDK que só monta o iframe (recomendada)

**Servidor:**
1. **Cookie do chat** passa a `SameSite=None; Secure; Partitioned` em produção (CHIPS).
   O navegador guarda um cookie separado por site que incorpora, que é exatamente o que
   um widget precisa: a sessão do lead no site da imobiliária X não vaza para outro
   site. Em desenvolvimento (`http://`), continua `Lax`, porque `None` exige `Secure`.
   **Testado no Chromium** (tabela acima): uma troca de atributo resolve.
2. **`Content-Security-Policy: frame-ancestors <domínios autorizados>`** na página
   `/chat/<slug>`, montado a partir da lista da agência. O navegador recusa o iframe em
   qualquer outro site. Pode morar no `src/proxy.ts`, com a lista em cache curto por
   *slug*.

**SDK:** um `widget.js` servido pela própria aplicação, com algumas dezenas de linhas
sem dependências:

```html
<script src="https://app.<domínio>/widget.js" data-agency="imobiliariax" async></script>
```

Ele desenha o botão flutuante, abre e fecha o iframe, e conversa com ele por
`postMessage`: abrir, fechar, mudar de tamanho e, mais tarde, contexto ("o lead está
vendo o imóvel AP-123"). O CSS do site não vaza para dentro do widget, nem o do widget
para fora.

**Compatibilidade:** `Partitioned` é suportado no Chrome e no Edge 114+, no Firefox
141+ e no Safari 26.2+. Num navegador mais antigo que bloqueie cookies de terceiros, o
stream volta 401. O widget pode detectar isso e oferecer "abrir a conversa em nova
aba", e lá o endereço é o próprio, e funciona.

**Tamanho:** pequeno. Um atributo de cookie, um cabeçalho com a lista da agência, um
arquivo estático, o campo na página de configurações e um teste.

### B. SDK que desenha o widget na página do site (sem iframe)

O widget vira um *bundle* próprio que roda no DOM da imobiliária e chama a API de
outra origem.

- **CORS** em `/api/chat*`, respondendo `Access-Control-Allow-Origin` só para os
  domínios autorizados, mais o *preflight* `OPTIONS`;
- **token em vez de cookie:** o `POST` devolve a sessão assinada no corpo, e o SDK a
  manda em `Authorization`;
- **stream sem `EventSource`,** que não aceita cabeçalhos. Ou o token vai na URL (e
  aparece em logs), ou o SSE é lido por `fetch` com `ReadableStream`, reimplementando a
  reconexão e o `Last-Event-ID` que o `EventSource` dá de graça;
- **build separado** do widget, fora do Next (hoje ele usa CSS Modules e componentes do
  app), dentro de *shadow DOM* para não brigar com o CSS do site.

Dá integração mais profunda, mas quase tudo isso a opção A alcança com
`postMessage`. O custo é várias vezes maior, e a superfície exposta (CORS com
credenciais) também. Fica para quando um cliente pedir algo que o iframe não consiga.

### C. WebSockets no lugar do SSE

**Não resolve o problema da seção 1.** O *handshake* do WebSocket é um `GET` com
`Upgrade` e leva cookies sob as mesmas regras de `SameSite` e de cookies de terceiros.
Num iframe, o cookie `Lax` também não iria. O WebSocket não passa por CORS, então o
servidor teria de checar o `Origin` sozinho. A autenticação teria de ser por token na
primeira mensagem, exatamente como na opção B. O transporte não muda nada disso.

**O que custaria neste código:**
- os *route handlers* do Next não aceitam `Upgrade`. Seria preciso um servidor
  customizado (um `server.ts` com `ws` envolvendo o Next), o que troca o `server.js`
  do `standalone` (§3 de [`hospedagem.md`](hospedagem.md)), ou um terceiro processo
  `realtime`, da mesma imagem, assinando o `Notifier`;
- a reconexão e o `Last-Event-ID`, que o SSE já resolve (`sse-replay.test.ts`), teriam
  de ser refeitos à mão;
- o envio continuaria fazendo sentido como `POST`, porque é ele que garante a
  idempotência pelo `clientMessageId`.

**Por destino:**

| | VPS (Caddy) | Azure Container Apps |
|---|---|---|
| Suporte | transparente, o `reverse_proxy` encaminha o `Upgrade` | suportado pelo ingress |
| Tempo de conexão | sem limite | o timeout de 240 s documentado para HTTP provavelmente também corta o WebSocket. Não verificado. A reconexão precisaria de lógica própria |
| Escala a zero | não se aplica | uma conexão aberta conta como requisição em andamento, como o SSE |
| Processo separado | mais um serviço no Compose | mais um Container App, com rota por caminho no ambiente |

**O que o WebSocket compraria:** um canal só para enviar e receber, e um indicador de
"lead digitando" para o corretor. Nada disso foi pedido. Na velocidade de um chat, o
`POST` por mensagem não pesa.

**Veredito:** manter o SSE. O que destrava o widget incorporado é a sessão (opção A),
não o transporte.

## 4. Achado lateral: as páginas do corretor podem ser incorporadas por qualquer site

Nenhuma resposta da aplicação manda `X-Frame-Options` ou `frame-ancestors`. Verificado
em `/login`, `/leads` e `/chat/demo`. Qualquer site pode exibir o login e o painel do
corretor num iframe (*clickjacking*). Isso é independente do widget e vale corrigir
antes do primeiro cliente: `frame-ancestors 'none'` em tudo, menos em `/chat/*`. A
opção A dá a `/chat/*` a política dele, por agência.

## Fontes

- [CHIPS (cookies particionados)](https://privacysandbox.google.com/cookies/chips):
  suporte Chrome 114, Edge 114, Firefox 141, Safari 26.2.
- [WebSockets com Next.js](https://websocket.org/guides/frameworks/nextjs/): *route
  handlers* não aceitam `Upgrade`; servidor customizado ou serviço separado.
- [Ingress no Azure Container Apps](https://learn.microsoft.com/azure/container-apps/ingress-overview):
  suporte a WebSocket, timeout de 240 s.
