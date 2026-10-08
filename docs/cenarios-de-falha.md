# Cenários de falha

Onde registramos cada jeito que o agente errou numa conversa real ou num teste — **antes** de decidir se é
defeito, indefinição de produto ou limite do modelo. A regra (29/09/2026): documentar sempre; corrigir só o que é
defeito claro; não colar no agente imobiliário o que é de outro agente; e não gastar tempo fechando furo que na
verdade é uma decisão de produto ainda não tomada.

**Dono** é quem deve resolver: uma spec, uma decisão pendente, ou o modelo.

## Abertos

| Cenário | Visto | Dono provável | Observação |
|---|---|---|---|
| Resposta genérica (*"tanto faz"*, *"qualquer um"*) a quartos, tamanho etc. às vezes dispara handoff — às vezes numa única resposta | Testes manuais do desenvolvedor | **011** (agente de investimento) + decisão de produto | Indefinição: o roteiro não diz o que *"sem preferência"* vale para cada campo. Adiado, por decisão de 29/09, para quando chegarmos no agente de investimento |
| O nome não é registrado (*"Bia"* → *"Como posso te chamar?"* de novo) | Replay de 29/09 (e4b) | 004 (extração) · modelo | Deslize de leitura; ver se persiste no 12B |
| Mudar de assunto com uma proposta aberta e escolher depois falha às vezes | `meeting-escapes`, ~2 em 10 (e4b) | Modelo | Os testes mostram os fatos extraídos quando falham |
| O modelo promete o que nenhuma ação fez: *"vou registrar seu interesse no sistema"*, *"vou verificar as outras opções"* | Conversas de 28 e 29/09 | **012** (guarda de fatos) | Não é do fluxo de agenda: nenhuma ação sustenta a frase · ver proposta *fronteira da Sofia* (manifesto de capacidades) · 30/09: a lista do que a Sofia pode (prompt fixo), a tarefa sem próximos passos e o texto de reserva do guard atacam as fontes |
| A resposta depois de uma busca numera cards que não são numerados (*"Os imóveis 1, 3 e 5…"*) | Replay de 28/09 | **012** | Mesma família: afirmar o que não está na tela |
| No celular (390 px), o menu do topo do painel fica apertado e corta *Agenda* | 28/09 | **014** (UX) | Anterior à 006 |
| Cenário 1 da compra: um guard reescreve uma resposta com duas perguntas (*"…pelo menos 2 quartos, sendo um deles usado como escritório, certo?"*) | Suíte de 29/09 (e4b) | Modelo | O guard fez o trabalho dele; o teste falha porque exige nenhuma reescrita |
| *"obrigado!"* com horários na mesa repete a mesma lista de horários | Replay de 29/09, conversa 5 (e4b) | Modelo (ecoa o imóvel) | Não fecha, como decidido; só soa robótico |
| O e4b às vezes não devolve a sobra de *"o condomínio aceita cachorro?"*, e a oferta de verificar com a equipe não acontece | Replay de 30/09, conversa 10, 1 em 3 (e4b) | Modelo | Quando a sobra vem, a oferta sai certa (conversas 7 e 10 nas outras rodadas) |
| A pergunta de bairro *"Tem algum bairro ou região específica em mente, ou aceita sugestões?"* é de ou-isto-ou-aquilo; um *"não"* (ou *"sim"*) não preenche nada | Teste do desenvolvedor, 30/09 08:39 (e4b) | **Produto** (texto da pergunta) · 004 | Com o bairro vazio, o roteiro não completa e a busca não roda |
| Duas respostas curtas não entendidas seguidas (*"sim"*, *"quero ver imóveis"*) viram handoff | Teste do desenvolvedor, 30/09 08:40 (e4b) | 004 FR-027 · decisão pendente 6 | Mesma família do *"tanto faz"* (011) |

## Resolvidos

| Cenário | Resolvido em | Como |
|---|---|---|
| Depois de marcar, *"vou levar meu cachorro"* recebeu horários de novo (o modelo ecoou o código do imóvel do card) | 07/10 (015) | Um código de imóvel só vale se está na mensagem; a frase recebe a oferta de verificar com a equipe |
| *"Posso levar meu cachorro?"* virou recusa e, somada a um *"não entendi"*, handoff | 07/10 (015) | Uma recusa só vale com palavra da lista fechada (carona, reembolso, gênero…) |
| *"Já marcamos, não?"* recebeu *"Ainda não consigo te ajudar com isso"* | 07/10 (015) | Lido pelo código como pergunta sobre o que está marcado; respondido a partir do estado |
| Depois do handoff, *"blz, no aguardo"* deixou os três pontinhos na tela para sempre | 07/10 (015) | O POST diz se vem resposta (`turn`); o widget não mostra *"digitando…"* numa conversa pausada, nem ao recarregar |
| *"Quero investir em imóveis para renda"* terminava com intenção **compra** (virava em *"Meu nome é Rafael…"*) | 30/09 (015) | Trocar uma intenção já definida exige palavra de finalidade na mensagem; os dois cenários avaliados passaram depois |
| Depois da devolução, *"a visita de segunda continua de pé?"* recebia *"Ainda não consigo te ajudar com isso"* | 30/09 (015) | Os compromissos marcados estão no estado; a pergunta é respondida a partir dele |
| *"Quem vai estar na visita?"* logo depois de a corretora se apresentar soava estranho | 30/09 (015) | *"Daqui eu só vejo dia, horário, tipo e imóvel; quem vai, só os corretores confirmam"* + oferta de chamar um |
| *"isso"* (confirmando valor e quartos) virou a intenção de aluguel para compra; *"Meu nome é Rafael"* fazia o mesmo com investimento | 30/09 (015) | Trocar uma intenção já definida exige palavra de finalidade na mensagem (filtro de evidência) |
| A Sofia ofereceu *"ver os imóveis"* antes de o roteiro estar completo, e o *"sim"* do lead não levou a nada | 30/09 (015) | A lista do que a Sofia pode diz que a busca acontece sozinha e proíbe oferecer buscar |
| Um segundo fechamento seguido saía como *"Oi de novo!"* | 30/09 (015) | A instrução de retomada não vale num turno que é despedida |
| *"meu marido vai junto"* depois de marcar recebia o fechamento | 30/09 (015) | A sobra que nada no turno responde recebe a oferta de verificar com a equipe; sim → handoff, não → fechamento |
| Depois de fechar, *"queria ver outros imóveis"* perguntava o bairro de novo (ou, com a 015, virava oferta à equipe) | 30/09 (015) | O código lê *"outros imóveis"* / *"mais opções"* como a pergunta sobre os critérios |
| O e4b lia *"não vou mais poder"* como remarcar (2 em 3 rodadas da avaliação) | 30/09 (015) | `readTurn`: sem palavra de remarcar/mudar/passar, é cancelamento |
| *"não vou mais poder na terça"* (encontro já passado) só era cancelamento se o modelo dissesse | 30/09 (015) | O verbo de cancelar basta; sem nada por vir, *"Não tenho nada marcado… Quer marcar uma?"* |
| Depois de uma recusa (carona), o *"valeu!"* seguinte vinha com a recusa repetida pelo modelo e virava handoff | 30/09 (015) | Uma mensagem que é só agradecimento não carrega pedido, recusa nem opt-out |
| Com horários na mesa, *"a primeira"* foi lido como o primeiro imóvel e nada foi marcado | 30/09 (015) | Com horários na mesa, um ordinal é escolha, lido pelo código |
| O modelo fazia pergunta quando a tarefa proibia (*"Você gostaria de marcar…?"* sobre opções já na tela) | 30/09 (015) | Guarda de saída: nessas tarefas, a frase com pergunta é descartada |
| O texto de reserva do guard prometia *"Já vou passar isso para o corretor que vai te atender"* | 30/09 (015) | Agora só *"Perfeito, anotado!"*: nenhuma ferramenta passa nada a ninguém |
| Depois de uma oferta de verificar com a equipe, *"pode ser a primeira opção"* virou sim e handoff | 30/09 (015) | A resposta à oferta só vale quando a mensagem não faz outra coisa que o turno trata |
| *"obrigado!"* depois de marcar prometia imóveis que ninguém buscou | 29/09 (009) | Fechamento escrito pelo código quando nada está pendente: *"Por nada! Fica marcado: … Se precisar de algo, é só chamar."*; um segundo seguido é curto |
| Com horários de quarta na mesa, *"quinta"* era ignorado e o *"10h"* marcava quarta | 29/09 (009) | Dia e período lidos pelo código (`parseWhen`); com horários na mesa, um dia citado re-propõe |
| O follow-up dizia *"até R$ 4 mil"* para R$ 3.500 | 29/09 (006) | Abaixo de 10 mil, o valor sai exato |
| No e4b, *"não, obrigado"* era lido como opt-out | 29/09 (009) | Descrição do `optOut` só aceita pedido explícito de parar de receber mensagens |
| Nova visita depois de a última passar era lida como remarcação (*"não encontrei nada para mudar"*) | 29/09 (009) | Sem encontro por vir, pedir horários vira agendamento novo; sem pedido, *"Não tenho nada marcado… Quer marcar uma?"* |
| Pedir uma conversa por telefone além da visita: *"amanhã"* virava outro dia e horários iam para o encontro errado | 29/09 (009) | *hoje/amanhã/depois de amanhã* lidos pelo código; horários de telefone na mesa continuam telefone mesmo com imóvel em jogo |
| *"ah verdade, essa já foi"* depois de *"Não tenho nada marcado… Quer marcar uma?"* recebe horários de uma conversa por telefone | 29/09 | Aceito como está (decisão do desenvolvedor) |
| O cenário 1 (compra, avaliado) falhava ~2 em 4 no e4b: contato não lido, busca não acionada | 29/09 | Troca para o gemma 12B (4 de 4). Se voltar ao e4b, o risco volta |
| Depois de marcar, *"não vou mais poder na sexta"* ouvia *"sem problema"* e a visita continuava marcada | 29/09 (006 FR-004g, depois 009) | "Proposta aberta" passou a ser uma linha ainda `proposed`; a 009 cancela de verdade, depois de perguntar |
| *"Pode ser domingo às 7?"* era lido como recusa (*"sem problema…"*) | 29/09 (009) | Uma mensagem que pede ou cita dia/horário não é recusa |
| *"Quem vai me atender?"* virava handoff ou *"ainda não consigo"* | 28/09 (006) | Fato `askedWhoAttends` e frase escrita pelo código |
| Pedidos de corretor por orientação sexual (*"queer"*, *"LGBT"*) nem sempre eram recusados | 28/09 (006) | Descrição do fato cita identidade de gênero e orientação sexual; recusa não conta como pedido de humano |
