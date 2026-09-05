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

## 1. Score do lead — fórmula, pesos e limiares

**Resolver em:** spec de resumo e scoring (item 7 do backlog)
**Prioridade:** alta — bloqueia o painel e o gatilho de handoff

### O que se sabe

Do enunciado do desafio e do material de ideação, o que está estabelecido é apenas:

- existe um campo `score` no lead
- é descrito como derivado dos **slots preenchidos** somados a **sinais de urgência**
- é recalculado ao fim da conversa, ou a cada N mensagens
- é exibido como **três faixas de temperatura** (quente, morno, frio)
- há um único valor de exemplo em todo o material — `87` — sugerindo escala 0–100
- tem dois consumidores: um score mínimo para o selo de "qualificado", e um score
  alto como gatilho de handoff

### O que NÃO está decidido

- **A fórmula.** Nenhum documento define como o score é calculado.
- **Os pesos.** Quanto vale cada slot preenchido? Urgência vale mais que orçamento?
- **Os limiares das faixas.** Onde termina frio e começa morno? E quente?
- **A cadência de recálculo.** "Ao fim da conversa ou a cada N mensagens" — qual N?
- **Determinístico ou por modelo.** Regra em código, ou o modelo atribui a nota?
  Esta é a decisão mais consequente das cinco: a versão por modelo é mais rica e
  menos previsível; a determinística é auditável, testável e explicável na banca.

### Nota

O material de ideação **não é fonte** para nenhuma dessas respostas — ele assume o
score como já existente. Não há o que "extrair" de lá.

---

## 2. Mecanismo de autenticação

**Resolver em:** spec de autenticação (item 3 do backlog)
**Prioridade:** média

### O que se sabe

Existe tela de login, usuários vêm por seed, e há distinção entre corretor (vê os
próprios leads) e gerente comercial (vê todos). Não há cadastro público.

### O que NÃO está decidido

Auth.js com credentials provider, ou um cookie de sessão assinado escrito à mão.

- **Auth.js** — mais convencional, extensível para OAuth depois, mais peso e
  configuração para um cenário de usuários semeados
- **Cookie assinado** — talvez 80 linhas, sem dependência, suficiente para dois
  papéis e nenhum cadastro; menos idiomático se o projeto crescer

---

## 3. Hospedagem do Langfuse na demonstração

**Resolver em:** spec do orquestrador (item 4 do backlog), junto com a taxonomia
de spans — que é onde a escolha finalmente pesa. Adiado deliberadamente pela spec
do item 1 ([`../specs/001-walking-skeleton/spec.md`](../specs/001-walking-skeleton/spec.md),
FR-034): o esqueleto entrega apenas a costura *fire-and-forget*, selecionada por
variável de ambiente, então adotar qualquer uma das duas formas depois não toca
código de aplicação.
**Prioridade:** média

Self-hosted por *profile* do Compose, ou Langfuse Cloud?

- **Self-hosted** — coerente com a promessa de rodar tudo em Docker Compose, e
  demonstra a stack completa. Custa seis contêineres e ~16 GiB recomendados,
  competindo com a inferência local pela memória da máquina.
- **Cloud** — zero contêineres, zero disputa de memória, e a interface fica
  disponível de qualquer lugar durante o pitch. Quebra a promessa de auto-suficiência
  local e depende de rede durante a apresentação.

Detalhes em [`arquitetura/restricoes-de-implantacao.md`](arquitetura/restricoes-de-implantacao.md).

---

## 4. Constantes do follow-up

**Resolver em:** spec do follow-up (item 11 do backlog)
**Prioridade:** baixa — valores iniciais bastam para começar

Janela de horário permitido, atraso até a primeira tentativa, crescimento do
intervalo entre tentativas e limite de tentativas.

O material de ideação sugere **janela de 9h às 20h** e **três tentativas**. Trate
como hipótese inicial, não requisito: nada no enunciado do desafio fixa esses
números, e eles precisam ser configuráveis por variável de ambiente de qualquer
forma.

Ponto que merece decisão explícita: se a janela é respeitada no fuso do lead ou no
fuso do servidor. Para uma POC nacional, provavelmente `America/Sao_Paulo` fixo — mas
isso é uma escolha, não um dado.

---

## 5. Gatilho de handoff

**Resolver em:** junto com o item 1 deste registro
**Prioridade:** alta, mas **bloqueada**

O handoff dispara quando o lead pede uma pessoa, quando faz pergunta fora de escopo,
ou quando o score está alto. Os dois primeiros são determinísticos. O terceiro
depende inteiramente da decisão 1 — não faz sentido escolher um limiar antes de
existir uma escala.

---

## Resolvidas

_(vazio — mova itens para cá conforme forem decididos, com link para a spec que os resolveu)_
