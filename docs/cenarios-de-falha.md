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
| *"Quero investir em imóveis para renda"* termina com intenção **compra** (vira em *"Meu nome é Rafael…"*) | Suíte de 29/09: 12B 1 em 3; e4b também | Modelo · **011** | O teste do cenário 2 mostra a intenção de cada turno quando falha |
| Mudar de assunto com uma proposta aberta e escolher depois falha às vezes | `meeting-escapes`, ~2 em 10 (e4b) | Modelo | Os testes mostram os fatos extraídos quando falham |
| O modelo promete o que nenhuma ação fez: *"vou registrar seu interesse no sistema"*, *"vou verificar as outras opções"* | Conversas de 28 e 29/09 | **012** (guarda de fatos) | Não é do fluxo de agenda: nenhuma ação sustenta a frase · ver proposta *fronteira da Sofia* (manifesto de capacidades) |
| A resposta depois de uma busca numera cards que não são numerados (*"Os imóveis 1, 3 e 5…"*) | Replay de 28/09 | **012** | Mesma família: afirmar o que não está na tela |
| No celular (390 px), o menu do topo do painel fica apertado e corta *Agenda* | 28/09 | **014** (UX) | Anterior à 006 |
| Cenário 1 da compra: um guard reescreve uma resposta com duas perguntas (*"…pelo menos 2 quartos, sendo um deles usado como escritório, certo?"*) | Suíte de 29/09 (e4b) | Modelo | O guard fez o trabalho dele; o teste falha porque exige nenhuma reescrita |
| *"meu marido vai junto"* depois de marcar recebe o fechamento (*"Combinado! Fica marcado…"*) — nenhum campo pega a informação | Conversa com o desenvolvedor, 29/09 | Proposta *fronteira da Sofia* | Deveria reconhecer, dizer que não garante e **oferecer** verificar com a equipe |
| Depois de fechar, *"queria ver outros imóveis também"* pergunta o bairro de novo (já era Vila Mariana), sem busca | Replay de 29/09, conversa 5 (e4b) | Proposta *fronteira da Sofia* · indefinição | Um pedido sem ramo no código; o modelo improvisa |
| *"obrigado!"* com horários na mesa repete a mesma lista de horários | Replay de 29/09, conversa 5 (e4b) | Modelo (ecoa o imóvel) | Não fecha, como decidido; só soa robótico |

## Resolvidos

| Cenário | Resolvido em | Como |
|---|---|---|
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
