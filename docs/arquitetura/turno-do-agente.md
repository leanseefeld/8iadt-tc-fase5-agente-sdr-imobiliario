# O turno do agente — quem decide o quê

> Mapa de referência para responder, a qualquer momento: **isto é uma chamada de modelo ou uma conta do código?
> E o que liga isso neste turno?** Descreve o código depois do `refactor-turn`: o turno é uma sequência de nós
> tipados em `src/agent/turn/` (a ordem está em `run.ts`). Cobre as specs 004, 005, 007, 006 (propor, reservar,
> o botão *Interessado* e o follow-up, marcados *(006)*), 009 (cancelar, remarcar, até três compromissos,
> *(009)*) e 015 (o que a Sofia não resolve: a oferta de verificar com a equipe, *(015)*). Qual modelo responde
> não é assunto deste mapa: é configuração, um perfil em `config/models/` ([ADR 23](adr/decisoes.md#23-model-profiles-in-yaml)).

## A regra, em uma frase

**O modelo lê, o código decide, o modelo só age pelas ferramentas que o código oferece, e só fala depois que
tudo foi decidido.** O que precisa ser exato — datas, recusas, avisos — o código escreve.

| Cor | Quem | O que é |
|---|---|---|
| 🟦 | **Código calcula** | Determinístico, testável sem modelo. Decide tudo o que importa. |
| 🟨 | **Modelo lê** | Extração: devolve JSON com slots e fatos. **Sem tools.** Não decide nada. |
| 🟥 | **Modelo age** | *Tool call* dentro do `act()`, só com as tools que o código ofereceu, no máximo 3 passos. O texto dessa chamada é **descartado** — nada dele chega ao lead. |
| 🟪 | **Modelo fala** | `phrase()`: a resposta, em streaming frase a frase, cada frase passando pelas guardas. |
| 🟩 | **Código escreve** | Frase fixa, sem modelo. Usada quando errar não é aceitável. |

## 1 · O turno em 30 segundos

Nove nós em fila, cada um com entrada e saída tipadas. Só três chamam o modelo para valer (`extract`, `act`,
`speak`); o `learn` chama um quarto, curto, só quando a extração volta de mãos vazias. A ordem é a precedência:
um nó que **responde o lead** encerra o turno, e um nó seguinte só roda quando nenhum anterior respondeu.

```mermaid
flowchart TD
    classDef codigo fill:#dbeafe,stroke:#1d4ed8,color:#0f172a
    classDef le fill:#fef9c3,stroke:#a16207,color:#0f172a
    classDef age fill:#fee2e2,stroke:#b91c1c,color:#0f172a
    classDef fala fill:#ede9fe,stroke:#6d28d9,color:#0f172a
    classDef escrita fill:#dcfce7,stroke:#15803d,color:#0f172a

    GATE["portão<br/>orchestrator.ts: runTurn<br/>conversa ativa · consentimento · um turno por vez"]:::codigo
    EXT["1 · extract<br/>o modelo lê a mensagem"]:::le
    READ["2 · read<br/>o código assenta o que ela diz"]:::codigo
    LEARN["3 · learn<br/>slots, score, releitura de um slot"]:::codigo
    CLASS["4 · classify<br/>o que o lead faz com a agenda"]:::codigo
    ACC["5 · account<br/>streak e handoff"]:::codigo
    DRAFT["6 · draft<br/>a resposta de agenda, escrita pelo código"]:::codigo
    ACT["7 · act<br/>o modelo chama as ferramentas oferecidas"]:::age
    ENDING["8 · ending<br/>oferta de verificar com a equipe, ou fechamento"]:::codigo
    SPEAK["9 · speak<br/>o modelo fala, frase a frase, com guardas"]:::fala
    FIN["finish<br/>commitTurn: mensagens, slots, eventos, uma transação"]:::codigo
    WRITTEN["frase escrita pelo código<br/>sem modelo"]:::escrita

    GATE --> EXT --> READ --> LEARN --> CLASS --> ACC --> DRAFT --> ACT --> ENDING --> SPEAK --> FIN
    GATE -.->|"manipulação"| WRITTEN
    EXT -.->|"extração falhou"| WRITTEN
    LEARN -.->|"opt-out"| WRITTEN
    ACC -.->|"handoff"| WRITTEN
    ENDING -.->|"agenda: opções, confirmação, recusa"| WRITTEN
    WRITTEN --> FIN
```

Linha tracejada: o turno acaba ali, com uma frase que o código escreveu. O `speak` ainda pode trocar a resposta
do modelo por uma frase escrita (*"ainda não consigo te ajudar com isso"*, ou a de reserva quando uma guarda
reprova a frase). Todos os caminhos terminam em `finish.ts`.

| Nó | Arquivo | Entrada → saída | Modelo? |
|---|---|---|---|
| portão | `agent/orchestrator.ts` (`runTurn`) · `turn/run.ts` | conversa ativa? algo sem resposta? consentimento? turno livre (`claimTurn`)? Dentro do `run.ts`: `looksLikeInjection` antes de qualquer modelo | não |
| ler | `turn/extract.ts` | turno carregado → `Extraction` (slots, fatos, ato da mensagem e a sobra) | 🟨 sim |
| assentar | `turn/read.ts` (+ `agent/lexicon.ts`) | `Extraction` + texto → `Reading`: um fato do modelo só vale se estiver nas palavras | não |
| aprender | `turn/learn.ts` | `Reading` + slots → `Learned` (slots, o que mudou, score) | só a releitura de um slot (`agent/recovery.ts`) |
| classificar | `turn/classify.ts` | `Reading` + o que está aberto → `Situation` (escolha, recusa, mudança, pergunta sobre o marcado…) | não, puro |
| contar | `turn/accounting.ts` | `Situation` → streak, handoff | não, puro |
| redigir | `turn/meeting-reply.ts` (+ `offer-times.ts`, `change.ts`) | `Situation` → `Draft` (frase escrita, prefixo, metadados) | não |
| agir | `turn/actions.ts` → `agent/act.ts` | `Draft` + plano → `ActionResults` → `Draft` | 🟥 sim, em `act()` |
| encerrar | `turn/ending.ts` (+ `boundary.ts`) | o turno até aqui → `Ending` (oferta à equipe ou fechamento) | não, puro |
| falar | `turn/speak.ts`, `turn/phrase.ts` | o que foi decidido → briefing → frase com guardas | 🟪 sim |
| gravar | `turn/finish.ts` → `services/conversation/commit.ts` | tudo → `commitTurn`, uma transação | não |

Apoio: `turn/types.ts` (contratos), `turn/messages.ts` (o texto sem resposta e o histórico enviado ao modelo),
`turn/sink.ts` (o canal por onde as frases saem). Como cada nó é uma função com tipos de entrada e saída, os
testes (`npm test`) rodam o turno inteiro com um modelo roteirizado (`tests/support/scripted-model.ts`), sem
modelo real; o que só o modelo real prova fica em `npm run eval` (`tests/eval/`).

**Por que três chamadas de modelo, e não uma.** `extract()` é um contrato JSON estreito, estabilizado a duras
penas no modelo 4-bit; pôr tools nele reintroduz a falha que o commit `7f2ded0` removeu. `phrase()` transmite
frases que **já chegaram à tela**; uma tool no meio dele buscaria depois de ter afirmado o resultado. O `act()`
fica no meio, onde nada foi dito ainda — e só roda quando há algo para fazer.

## 2 · O turno, decisão por decisão

O mesmo caminho, agora com cada pergunta que o código faz. As caixas dizem o arquivo e a função; as marcações
*(006)*, *(009)* e *(015)* dizem de qual spec vem a regra.

```mermaid
flowchart TD
    classDef codigo fill:#dbeafe,stroke:#1d4ed8,color:#0f172a
    classDef le fill:#fef9c3,stroke:#a16207,color:#0f172a
    classDef age fill:#fee2e2,stroke:#b91c1c,color:#0f172a
    classDef fala fill:#ede9fe,stroke:#6d28d9,color:#0f172a
    classDef escrita fill:#dcfce7,stroke:#15803d,color:#0f172a

    IN(["Mensagem do lead<br/>digitada, ou pelo botão Interessado do card (006)<br/>depois de CHAT_DEBOUNCE_MS de silêncio"]) --> GATE{"Portão — runTurn<br/>conversa ativa · algo sem resposta<br/>consentimento · um turno por vez"}:::codigo
    GATE -- "não" --> QUIET(["Sem turno<br/>corretor assumiu, nada novo,<br/>ou antes do Aceito (frase fixa, sem modelo)"])
    GATE -- "sim" --> INJ{"looksLikeInjection?<br/>run.ts"}:::codigo
    INJ -- "sim" --> W_REF["refusalReply"]:::escrita
    INJ -- "não" --> EXT["extract.ts — extract()<br/>slots + fatos da mensagem<br/>015: o ato da mensagem e a sobra"]:::le
    EXT --> FAIL{"extração falhou?"}:::codigo
    FAIL -- "sim" --> W_FAIL["aviso de falha técnica<br/>streak mantém"]:::escrita
    FAIL -- "não" --> READ["read.ts — readTurn()<br/>dia e período · sim/não · verbos de mudança<br/>015: só obrigado/ok · escolha de horário · outros imóveis"]:::codigo
    READ --> MERGE["learn.ts — mergeSlots<br/>filled · revised · intentChanged · dropped"]:::codigo
    MERGE --> REC{"shouldRecover?"}:::codigo
    REC -- "sim" --> RSLOT["recoverSlot()<br/>um slot só"]:::le
    REC -- "não" --> OPT{"optOut?"}:::codigo
    RSLOT --> OPT
    OPT -- "sim" --> W_OPT["OPT_OUT_REPLY"]:::escrita
    OPT -- "não" --> CLASS["classify.ts — classify()<br/>escolha · recusa · mudança · interesse<br/>pergunta sobre o marcado · resposta à oferta"]:::codigo
    CLASS --> ACC["accounting.ts — accountTurn<br/>streak: zera · mantém · avança"]:::codigo
    ACC --> HO{"handoffDecision<br/>pediu humano · streak em 2<br/>006: não, se a mensagem é sobre o encontro<br/>015: sim à oferta de verificar com a equipe"}:::codigo
    HO -- "sim" --> W_HO["handoffReply"]:::escrita
    HO -- "não" --> MEET["meeting-reply.ts — draftMeetingReply (006)<br/>formato ou pedido fora do domínio → ainda não consigo (streak avança)<br/>recusa → declineProposal · pedido ou interesse → meetingTarget<br/>visita sem imóvel → pergunta qual · senão proposeAppointment<br/>009: mudar o que foi marcado → decideChange<br/>qual delas? · quer mesmo cancelar? · remarcar → opções"]:::codigo
    MEET --> ACTQ{"actions.ts — algo devido e nada respondeu ainda?<br/>busca devida · 006: proposta aberta + pickedTime<br/>009: compromisso a remarcar"}:::codigo
    ACTQ -- "sim" --> ACT["act.ts — act(), até 3 passos<br/>searchProperties<br/>006: bookMeeting · 009: rescheduleMeeting"]:::age
    ACTQ -- "não" --> OUTC
    ACT --> OUTC["actions.ts — applyActionOutcomes<br/>reservou → confirmação · recusada → motivo e novas opções<br/>escolheu e nada reservou → as mesmas opções"]:::codigo
    OUTC --> ENDING["ending.ts — decideEnding<br/>015: sobrou pedido, pergunta ou informação que nada respondeu → oferta<br/>009: nada pendente, nada perguntado → fechamento"]:::codigo
    ENDING --> AGENDA{"o código já escreveu a resposta?<br/>opções · confirmação · recusa da reserva"}:::codigo
    AGENDA -- "sim" --> W_MEET["frase escrita pelo código<br/>datas, horários e quem atende<br/>(equipe ou especialista), sem nome"]:::escrita
    AGENDA -- "não" --> CANT{"speak.ts — tentou algo que não dá<br/>para usar e fez uma pergunta?"}:::codigo
    CANT -- "sim" --> W_CANT["ainda não consigo te ajudar com isso"]:::escrita
    CANT -- "não" --> TASK["speak.ts — briefing e chooseTask()<br/>reconfirmação · último resultado de busca<br/>escolhe UMA instrução por precedência"]:::codigo
    TASK --> PHR["phrase.ts — phrase()<br/>streaming frase a frase<br/>006: depois de um prefixo escrito, se houver"]:::fala
    PHR --> GRD{"guardas por frase<br/>sintaxe · idioma · valores · nº de perguntas<br/>015: sem a pergunta da oferta, o código a acrescenta"}:::codigo
    GRD -- "reprovou" --> W_FB["fallbackText"]:::escrita
    GRD -- "passou" --> COMMIT
    W_REF & W_FAIL & W_OPT & W_HO & W_MEET & W_CANT & W_FB --> COMMIT["finish.ts — commitTurn<br/>mensagens · slots · eventos<br/>006: opções e reserva nos metadados<br/>006: agenda o follow-up se sobrou pergunta ou opções"]:::codigo
```

## 3 · O que fica guardado entre um turno e outro

Nada vive na memória do processo: um turno carrega tudo no começo (`loadTurn`) e grava tudo no fim
(`commitTurn`). O que o turno seguinte precisa saber está em linhas — `conversations`, `leads`, `appointments`
— e nos **metadados da última resposta** (`messages.metadata`: `meetingOptions`, `pendingCancel`, `humanOffer`,
`closing`… ver [`modelo-de-dados.md`](modelo-de-dados.md) §1).

```mermaid
stateDiagram-v2
    direction LR

    state "Conversa" as CONV {
        [*] --> ativa
        ativa --> pausada: handoff, ou corretor assume
        pausada --> ativa: corretor devolve (linha de reentrada escrita)
        ativa --> fechada: optOut
    }

    state "Oferta de encontro (006)" as OFERTA {
        [*] --> semOferta
        semOferta --> proposta: shouldProposeMeeting, ou askedForTimes com roteiro completo
        proposta --> proposta: askedForTimes ou interesse (cancela a anterior e insere)
        proposta --> proposta: bookMeeting recusado (motivo + novas opções)
        proposta --> confirmada: pickedTime e bookMeeting, revalidado
        proposta --> recusada: declinedOffer com proposta aberta agora
        confirmada --> aguardaSim: pedir para cancelar → quer mesmo cancelar? (009)
        aguardaSim --> cancelada: sim → cancelAppointment
        aguardaSim --> confirmada: não → continua marcada
        recusada --> proposta: o lead pede de novo
        confirmada --> realizada: corretor marca feita
        confirmada --> cancelada: corretor cancela, pela agenda
        confirmada --> confirmada: remarcar → rescheduleMeeting, mesma linha, mesma regra (009)
    }

    state "Oferta de verificar com a equipe (015)" as EQUIPE {
        [*] --> semOfertaEquipe
        semOfertaEquipe --> ofertada: sobra que nada no turno respondeu
        ofertada --> handoff: sim
        ofertada --> fechamento: não
        ofertada --> semOfertaEquipe: outra coisa (turno normal)
    }

    state "Follow-up (006)" as FU {
        [*] --> none
        none --> pending: turno deixa pergunta ou opções por último
        pending --> none: lead respondeu
        pending --> pending: enviado, próxima tentativa (intervalo × fator)
        pending --> pending: fora da janela (move para a abertura)
        pending --> none: chave desligada, opt-out, pausa ou visita confirmada
        pending --> exhausted: tentativas esgotadas
        exhausted --> none: lead respondeu (followup.recovered)
    }
```

- **Uma oferta recusada não é oferecida de novo por conta própria** — `offerOutstanding` continua verdadeiro
  porque a mensagem da oferta está no histórico. O lead pode sempre pedir.
- **Sem horário, sem handoff automático** (006): o agente diz que não há horário agora e mantém a proposta anterior aberta; quem quer uma pessoa pede.
- **Uma mensagem sobre o encontro não é pedido de humano** (006): a extração lê *"a segunda"* ou *"quero agendar"*
  como `askedForHuman`, porque o encontro é com uma pessoa. Quando a mesma mensagem escolhe, pede ou recusa
  horários, o código ignora esse fato. E uma escolha vence um pedido de horários na mesma mensagem.
- **Visita só com imóvel; o outro encontro é por telefone** (006): com cards na tela e nenhum apontado, o agente pergunta
  qual imóvel (botão *Interessado* ou código) e oferece o telefone; isso já conta como a oferta, para não repetir.
  Pedido de encontro no escritório, por Meet, Zoom, FaceTime ou outro formato: *"ainda não consigo te ajudar com
  isso"* e o telefone, se nenhum já estiver marcado. Pedido fora do domínio numa visita (carona, reembolso, escolher
  quem atende por uma característica pessoal): só *"ainda não consigo"*. Os dois avançam o streak.
- **Nenhum nome de corretor chega ao modelo por causa da agenda** (006): opções, confirmação e remarcação são
  escritas pelo código e dizem *"alguém da nossa equipe"*. A exceção é o investidor cujo corretor tem
  `investment` em `specializations` (`chooseBroker` o prefere), que ouve *"nosso especialista em investimentos"*
  (`meetingHostFor` em `turn/offer-times.ts`, que confere o corretor de fato atribuído). Nome, nunca. Depois de
  uma devolução, o modelo não confirma nem nega quem atende.
- **Uma proposta aberta não sequestra a conversa**: o lead pode mudar de assunto e voltar a ela depois.
- **O streak de não compreensão** é um número em `conversations.fallbackStreak`: zera quando o turno aprende
  algo, **mantém** em conversa fiada ou falha técnica, **avança** quando o lead tentou algo inutilizável. Em 2,
  handoff.
- **Follow-up**: só a chave da agência (006) e a janela de horário decidem se uma tentativa **devida** sai; o
  agendamento não consulta a chave.

## 4 · Quem faz cada verbo, e o que o liga neste turno

Caminhos abaixo relativos a `src/`. *Turno* = `agent/turn/`.

| Verbo | Quem | Onde | Liga quando |
|---|---|---|---|
| botão **Interessado** no card *(006)* | 🟩 widget envia | `app/(public)/chat/[agencySlug]/PropertyCard.tsx` | clique ou toque: posta *"Interessado em VMA-0005"* em nome do lead, como mensagem dele, e um turno normal começa; a resposta depende de onde a conversa está (FR-004d) |
| debounce · `claimTurn` | 🟦 código | `channels/web.ts` · `jobs/unanswered-turns.ts` · `services/conversation/claim.ts` | toda mensagem; um turno por conversa, depois de `CHAT_DEBOUNCE_MS` de silêncio |
| `looksLikeInjection` | 🟦 código | `domain/injection.ts`, chamado por `turn/run.ts` | todo turno; três frases fixas de tentativa de manipulação |
| `extract()` | 🟨 modelo lê | `turn/extract.ts` | todo turno que passou do portão. Devolve slots e os fatos `askedForHuman`, `optOut`, `attemptedAnswer`, `askedAboutCriteria`; **006:** `declinedOffer`, `askedForTimes`, `pickedTime`, `preferredWeekday`, `preferredPeriod`, `propertyPosition`, `propertyCode`, `askedWhoAttends`, **009:** `changeRequest`, `answer`, `meetingKind`, `unsupportedMeeting`, `outOfScopeRequest`; **015:** `askedAboutMeetings`, `messageAct` (agradece, concorda, responde, pede, pergunta, informa, outro) e `uncovered` (a sobra: o que nenhum campo registrou). **Duas tentativas:** uma chamada que falha ou uma resposta que não é JSON tenta de novo uma vez; na segunda falha, o turno segue sem nada aprendido (resposta honesta, e o streak decide o humano). Cada tentativa falha fica no Langfuse como `ERROR` |
| `readTurn` — leituras do código *(009, 015)* | 🟦 código | `turn/read.ts` · `agent/lexicon.ts` | o nó que assenta o que a mensagem diz: tudo o que vem depois decide a partir dele, nunca do texto cru. **Um fato que o modelo afirma precisa estar nas palavras**: um código de imóvel que a mensagem não contém, uma recusa sem palavra de recusa ou uma troca de intenção sem palavra de finalidade são descartados (o modelo ecoa o que leu antes). Todo turno, depois da extração: dia e período (`parseWhen`), sim/não a uma pergunta pendente, verbos de remarcar e cancelar, *"já marcamos?"*; uma mensagem que é **só** agradecimento ou concordância (*obrigado, valeu, ok, beleza, 👍*) vale como tal, seja lá o que o modelo leu, e não carrega pedido (recusa, humano, opt-out); *"outros imóveis"* / *"mais opções"* é a pergunta sobre os critérios; com horários na mesa, *"a primeira"*, *"2"*, *"opção 3"* é uma escolha. Vocabulário fechado, como o `parseWhen` |
| `boundaryOffer` *(015)* | 🟦 código | `turn/boundary.ts` · `turn/ending.ts` | a mensagem pede, pergunta ou informa algo que sobrou, **e** o turno não tem nada melhor a dizer (nenhuma frase escrita, busca, critérios, pergunta sobre o marcado, nada aprendido). O modelo escreve a oferta (reconhece, diz que não consegue confirmar, oferece que alguém da equipe verifique); se esquecer a pergunta, o código a acrescenta (`mustAsk`). A oferta fica pendente (`humanOffer`): **sim** → handoff normal; **não** → fechamento; outra coisa → turno normal. A pergunta do roteiro espera um turno |
| `recoverSlot()` | 🟨 modelo lê | `agent/recovery.ts`, chamado por `turn/learn.ts` | slot pendente ficou vazio, a extração não disse nada dele (`shouldRecover`), **e** o lead tentou responder |
| `mergeSlots` | 🟦 código | `domain/slots.ts`, chamado por `turn/learn.ts` | todo turno; separa preenchido, revisado, intenção trocada e recusado |
| `accountTurn` | 🟦 código | `turn/accounting.ts` | todo turno; decide o streak. **006:** um pedido que a imobiliária não atende (encontro no escritório ou por vídeo, carona, escolher quem atende por aparência, cor, gênero, ideologia…) **avança** o streak, mesmo que o turno tenha aprendido algo |
| `handoffDecision` | 🟦 código | `domain/handoff.ts` | lead pediu humano (**006:** numa mensagem que não é sobre o encontro), ou streak chegou a 2 |
| `shouldProposeMeeting` | 🟦 código | `domain/handoff.ts` | roteiro completo (compra/aluguel: quente e com contato; investimento: sempre) **e** nenhuma oferta já feita (`offerOutstanding`) |
| `meetingTarget` *(006)* | 🟦 código | `turn/offer-times.ts` | antes de propor: investidor → conversa por telefone; pediu telefone → telefone; horários de telefone já na mesa → telefone *(009)*; imóvel em jogo → visita; cards na tela e nenhum apontado → **pergunta qual imóvel** (ou oferece o telefone), sem horários; nada mostrado ainda → telefone |
| `proposeAppointment` *(006)* | 🟦 código | `services/scheduling.ts`, chamado por `turn/offer-times.ts` | `shouldProposeMeeting`, **ou** `askedForTimes`/interesse com roteiro completo (incompleto: *"Assim que eu tiver seus dados…"*, uma vez; já agendado: *"ainda não consigo"*). Dia e período pedidos filtram **antes** do limite de três. Datas e horários são escritos pelo código |
| `resolvePropertyRef` *(006)* | 🟦 código | `services/conversation/state.ts`, chamado por `turn/run.ts` | a extração trouxe `propertyRef` (*"o segundo"*, *"VMA-0005"*); resolve só contra imóveis **já mostrados nesta conversa**, nunca adivinha |
| `declineProposal` *(006)* | 🟦 código | `services/scheduling.ts`, chamado por `turn/meeting-reply.ts` | `declinedOffer` **com proposta aberta agora** — uma linha ainda `proposed` (`turn.proposalOpen`), não "já houve oferta" (`appointmentProposed`, que só evita repetir a oferta). Depois de uma reserva, *"não vou mais poder"* não é recusa: é pedido de cancelamento (009) |
| `parseWhen` *(009)* | 🟦 código | `agent/meeting-change.ts`, chamado por `readTurn` | todo turno: lê do texto os dias da semana, *manhã/tarde* e *hoje/amanhã/depois de amanhã* (relativos à data de hoje) e completa o que o modelo extraiu — o que o código acha vale mais. Com horários na mesa, um dia ou período sozinho (*"nada na quarta?"*) pede outras opções da proposta, a não ser que a mensagem diga para remarcar ou cancelar |
| fechamento *(009, 015)* | 🟪 modelo, com os fatos do código | `turn/ending.ts` (decide) · `chooseTask` `closing` · `describeMeeting` | nada pendente, nenhuma pergunta, nada aprendido, nenhuma sobra, e já houve oferta ou há compromisso — ou um **não** à oferta de verificar com a equipe. O código passa o que está marcado; o modelo lembra isso e se despede, sem pergunta (a guarda de saída descarta uma). Um segundo fechamento seguido é só a despedida. A mensagem seguinte do lead é uma retomada: o modelo cumprimenta com naturalidade antes de seguir |
| o que a Sofia pode *(015)* | 🟦 prompt fixo | `agent/prompts/system.ts` `CAPABILITIES` | todo `phrase()`: buscar, marcar/remarcar/cancelar, explicar os critérios; o que **não** consegue garantir (acompanhantes, animais, desconto, financiamento, condomínio…); nunca anunciar uma ação fora da lista. Fica na parte constante do prompt, que o cache guarda. Desconto deixou de ser recusa: vira oferta |
| `decideChange` *(009)* | 🟦 código | `turn/change.ts` · `agent/meeting-change.ts` | `changeRequest` (cancelar/remarcar), um `answer` sim/não à pergunta anterior, ou a resposta a *"qual delas?"* — lida contra os compromissos listados (`matchAnswer`). Cancelar só depois do sim (`cancelAppointment`); remarcar vai ao `act()` e, sem horário dito, oferece horários daquele compromisso; depois de cancelar, um sim a *"quer marcar outro dia?"* oferece de novo. Até **três** compromissos futuros por lead |
| `rescheduleMeeting` *(009)* | 🟥 tool | `agent/tools/reschedule-meeting.ts` | dentro do `act()`, quando o lead está remarcando. Move **a mesma linha** e revalida com o mesmo `checkSlot` da marcação, ignorando só o horário do próprio compromisso. O briefing traz os próximos sete dias já calculados, para "segunda" nunca virar uma segunda que passou |
| pergunta sobre o que está marcado *(015)* | 🟪 modelo, com o estado | `turn/speak.ts` (`booked`, `askedAboutMeetings`) · `chooseTask` `meetings.status` | *"a visita continua de pé?"*: o estado da frase traz os compromissos marcados (sempre que houver) e o modelo responde só com eles, sem pergunta. Sem nada marcado: *"Não tenho nenhuma visita ou conversa marcada…"* |
| quem vai atender *(006, 015)* | 🟩 código | `agent/prompts/meeting.ts` `ATTENDEE_UNKNOWN_SENTENCE`, escolhida em `turn/meeting-reply.ts` | *"Daqui eu só consigo ver o dia, o horário, o tipo e o imóvel…; quem vai te atender, só os corretores conseguem confirmar. Quer que eu chame um corretor…?"* — a oferta fica pendente como a da fronteira; sim → handoff |
| `nextQuestion` | 🟦 código | `domain/slots.ts`, chamado por `turn/run.ts` | quando não há oferta nem handoff no turno — **quem escolhe a próxima pergunta é sempre o código** |
| `act()` | 🟥 modelo age | `agent/act.ts`, chamado por `turn/actions.ts` (`runActions`) | critério de busca preenchido ou revisado com o roteiro qualificado; **006:** ou proposta aberta **e** `pickedTime` sem recusa; **009:** ou um compromisso a remarcar. Só se nada (handoff, frase escrita) já respondeu. No máximo 3 passos (`MAX_ACTION_STEPS`) |
| `searchProperties` | 🟥 tool | `agent/tools/search-properties.ts` | dentro do `act()`. Agência e a recusa para investidor vêm do código, nunca do argumento. **006 FR-020:** uma área pedida casa com o bairro **ou a região** (*"zona norte"* acha Santana) |
| `bookMeeting` *(006)* | 🟥 tool | `agent/tools/book-meeting.ts` | dentro do `act()`. Revalida pelo mesmo cálculo que gerou as opções |
| reconfirmação | 🟦 código | `domain/revision.ts`, chamado por `turn/speak.ts` | slot já preenchido foi revisado, tem dependentes, o turno anterior não foi reconfirmação, **e nenhuma busca apareceu neste turno** |
| `lastSearchOutcome` | 🟦 código | `services/conversation/state.ts`, chamado por `turn/speak.ts` | turnos sem busca; é a última busca lida das mensagens gravadas |
| `chooseTask()` | 🟦 código | `agent/prompts/system.ts` | escolhe **uma** instrução para o `phrase()`, nesta ordem: resultado de busca (`search.one` · `search.many` · `search.none`) › pergunta sobre critérios (`criteria.*`) › reconfirmação (`reconfirm`) › oferta à equipe (`boundary`) › pergunta sobre o marcado (`meetings.status`) › fechamento (`closing`) › nada a perguntar (`nothingToAsk`) › pergunta do roteiro (`question`). Confirmação e opções de horário são frases escritas e nem chegam aqui; a aceitação de uma recusa vem **antes** do vencedor, como prefixo, e só suprime opções e reconfirmação |
| `phrase()` | 🟪 modelo fala | `turn/phrase.ts`, chamado por `turn/speak.ts` | sempre que o turno não terminou numa frase escrita |
| guardas | 🟦 código | `domain/reply-guards.ts`, chamado por `turn/phrase.ts` | cada frase: sintaxe vazada, idioma, valor sem lastro, número de perguntas |
| frases escritas | 🟩 código | `agent/prompts/fallback.ts` · `agent/prompts/meeting.ts` · `services/handoff.ts` | recusa, falha técnica, opt-out, handoff, *"ainda não consigo"*, reentrada (`services/handoff.ts`); **006:** opções, confirmação, motivo de uma reserva recusada, recusa aceita, *"assim que eu tiver seus dados"*, e *"ainda não consigo te dizer o nome de quem vai te atender"* quando há proposta ou visita |
| card do encontro *(006)* | 🟩 widget | `app/(public)/chat/[agencySlug]/MeetingCard.tsx` | mensagem com `booking` nos metadados: dia, hora, tipo e — numa visita — o código do imóvel; nunca o corretor |
| `commitTurn` | 🟦 código | `services/conversation/commit.ts`, chamado por `turn/finish.ts` | fim de todo turno; **006:** grava `meetingOptions`, `offerDeclined`, `interestedProperty` e `booking` nos metadados da resposta, e agenda o follow-up (`scheduleFollowup`) se sobrou pergunta do roteiro ou opções |
| `cancelFollowup` *(006)* | 🟦 código | `services/followup.ts` · chamado por `recordLeadMessage` (`services/conversation/inbound.ts`) | toda mensagem do lead: cancela tentativas pendentes, zera contagem e estado; se um follow-up já tinha saído, `followup.recovered` uma vez |
| varredura de follow-up *(006)* | 🟦 código + 🟪 modelo escreve | `jobs/followup.ts` · `agent/followup-writer.ts` | worker, a cada varredura; claim com `SKIP LOCKED`; elegibilidade checada duas vezes (depois do claim e antes do envio), incluindo a chave da agência; o modelo escreve só a frase de abertura, conferida (sem pergunta, data, hora ou nome da equipe) e trocada por uma escrita pelo código se reprovar; a pergunta pendente é do código |

## 5 · O cache de prefixo: o que muda fica no fim

Num modelo local, reler o prompt inteiro a cada turno é a maior parte da latência. O servidor (oMLX, e também a
Azure OpenAI) guarda um **cache de prefixo**: o trecho inicial idêntico ao da chamada anterior não é processado
de novo. Mas um prefixo é um prefixo: o primeiro byte diferente invalida tudo o que vem depois. Por isso:

- **O system prompt de cada chamada é constante.** `REPLY_SYSTEM_PROMPT` (persona, o que a Sofia pode, regras) e
  `extractionSystemPrompt()` não recebem nenhum dado do turno (`agent/prompts/system.ts`).
- **O que muda a cada turno vai no fim.** O estado da qualificação, o que acabou de ser aprendido e a tarefa do
  turno (`turnBriefing`) entram na última mensagem, cercados e rotulados, logo antes das palavras do lead
  (`briefed` em `turn/messages.ts`).
- **A conversa é montada sempre do mesmo jeito** (`toModelMessages`), para que o que já foi dito chegue com os
  mesmos bytes a cada turno. As passagens de humano para agente e vice-versa entram na própria transcrição, no
  ponto em que aconteceram, e não num resumo que mudaria a cada chamada. A resposta lê a conversa inteira (até
  `MODEL_HISTORY_WINDOW`, 12 mensagens), então o prefixo dela cresce com a conversa até lá. A extração lê só as quatro últimas
  mensagens, uma janela que anda, então o que fica em cache para ela é o system prompt, que é a maior parte da
  entrada.
- **Medido, não suposto.** Cada geração no Langfuse carrega `cache_read` (`prompt_tokens_details.cached_tokens`),
  ligado em `agent/provider.ts` (`includeUsage`) e registrado em `core/langfuse.ts`.

**O que as medições mostraram** (detalhes em `specs/004-conversation/implementation-log.md`, 15/09/2026):

| Medição | Cache |
|---|---|
| e4b, três turnos, estado do turno **dentro** do system prompt (desenho antigo) | 0% → 10,2% → 9,4%: o cache ficava preso nos primeiros 512 *tokens* e a taxa **caía** conforme a conversa crescia |
| e4b, mesmos turnos, system prompt constante e estado no fim (desenho atual) | 11,1% → 81,4% → 84,4%: o cache cresce com a conversa |
| 12B, conversas de exemplo de 10/10 (média por tipo de chamada, no Langfuse) | extração 75% · resposta 68% · ações 78% · resumo 87% |

**O que ficou de fora, de propósito.** O oMLX guarda um cache por vez, e a extração e a resposta têm system
prompts diferentes, então uma desaloja a outra dentro do mesmo turno. Por isso, nas conversas de 10/10, o
trecho em cache fica no tamanho do system prompt e não cresce com a conversa. Um prefixo único para as duas
chamadas foi medido e levaria a segunda chamada do turno a 88–98% de cache, mas não foi adotado: a resposta
passaria a carregar as ferramentas e o guia de campos da extração, e o modelo leria ferramentas que não pode
chamar. Com um modelo hospedado, que guarda vários prefixos, a questão desaparece.

## Ver também

- [`visao-geral.md`](visao-geral.md) §5 (fluxos) e §9 (defesas contra manipulação)
- [ADR 22](adr/decisoes.md#22-revisable-qualification-state-and-actions-as-tool-calls) — por que ações viraram tools e o estado ficou revisável
- Spec 007 — [`contracts/observability.md`](../../specs/007-revisable-orchestration/contracts/observability.md): como cada passo aparece no Langfuse
