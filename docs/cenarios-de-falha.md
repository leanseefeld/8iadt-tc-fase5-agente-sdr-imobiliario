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
| No 12B, *"Quero investir em imóveis para renda"* termina com intenção **compra** | Suíte de 29/09, 1 em 3 execuções | Modelo · **011** | O teste do cenário 2 agora mostra a intenção de cada turno quando falha |
| Mudar de assunto com uma proposta aberta e escolher depois falha às vezes | `meeting-escapes`, ~2 em 10 (e4b) | Modelo | Os testes mostram os fatos extraídos quando falham |
| O modelo promete o que nenhuma ação fez: *"vou registrar seu interesse no sistema"*, *"vou verificar as outras opções"* | Conversas de 28 e 29/09 | **012** (guarda de fatos) | Não é do fluxo de agenda: nenhuma ação sustenta a frase |
| Depois da conversa por telefone confirmada, *"obrigado!"* → *"De nada! Agora vou te mostrar algumas opções de imóveis que se encaixam no que você procura. 😊"* — sem cards, nenhuma busca | Teste do desenvolvedor, 29/09 (e4b, celular) | **012** (guarda de fatos) · indefinição | Promessa de uma ação que nenhuma ferramenta fez. Provável gatilho: com o roteiro completo e tudo marcado, o turno não tem pergunta nem tarefa, e o modelo improvisa um "próximo passo". Falta decidir o que o agente diz quando não há nada pendente (um fechamento) |
| Com horários de quarta na mesa, *"quinta"* sozinho é ignorado (e4b: pergunta de bairro sem sentido; 12B: repete quarta), e o *"10h"* seguinte marca **quarta** | Reprodução de 29/09, e4b e 12B | **009** (código) | Um dia ou período solto, com proposta aberta, deveria re-propor com essa restrição |
| O follow-up diz *"até R$ 4 mil"* para quem pediu R$ 3.500 | Follow-ups da Julia, 28 e 29/09 | **006** (código) | Arredondamento em `searchDetail` do escritor de follow-up |
| No e4b, *"não, obrigado"* (a uma oferta) foi lido como opt-out e encerrou a conversa | Reprodução de 29/09, só e4b | Modelo · descrição do opt-out | Irreversível pelo chat; o 12B não errou |
| A resposta depois de uma busca numera cards que não são numerados (*"Os imóveis 1, 3 e 5…"*) | Replay de 28/09 | **012** | Mesma família: afirmar o que não está na tela |
| No celular (390 px), o menu do topo do painel fica apertado e corta *Agenda* | 28/09 | **014** (UX) | Anterior à 006 |
| Lead volta **depois** do horário da visita e pede *"podemos marcar uma nova visita pra quinta?"* → *"Não encontrei nenhuma visita ou conversa marcada para mudar."* Em seguida, *"podemos marcar uma nova?"* | Teste do desenvolvedor, 29/09 (e4b, celular) | **009** (código) · modelo | Extração: `changeRequest: reschedule` **e** `askedForTimes: true`, `meetingKind: visit`, `preferredWeekday: thu`. Como a visita já tinha passado, não há compromisso futuro para remarcar, e o código parou em *"não encontrei"* em vez de tratar como pedido de **nova** visita (mesmo imóvel, quinta). Duas partes: o modelo leu *"nova visita"* como remarcação; e o código não cai para "oferecer" quando não há o que remarcar mas o lead pediu horários. Registrado, **não corrigido** — o desenvolvedor ainda está testando |
| Com uma visita marcada, pedir **também** uma conversa por telefone foi penoso: funcionou, mas só com paciência do lead | Teste do desenvolvedor, 29/09 (e4b, celular) | **009** (código) · modelo | Três deslizes na mesma conversa: **(a)** *"amanhã de tarde"* (amanhã = qua 30/09) veio como ter 06/10 — não existe noção de "hoje/amanhã" na extração, só dia da semana, e o modelo chutou; **(b)** com a proposta da conversa **aberta**, *"nada na quarta?"* virou *"Para remarcar a visita ao MOE-0001…"* — o pedido de outros horários foi aplicado à visita já marcada em vez da proposta aberta (o código não dá precedência à proposta aberta sobre o compromisso marcado); **(c)** depois de *"não quero remarcar a visita… quero só uma conversa por telefone amanhã (além da visita)"*, as opções vieram para qui 01/10, não para amanhã. Registrado, **não corrigido** |

## Resolvidos

| Cenário | Resolvido em | Como |
|---|---|---|
| O cenário 1 (compra, avaliado) falhava ~2 em 4 no e4b: contato não lido, busca não acionada | 29/09 | Troca para o gemma 12B (4 de 4). Se voltar ao e4b, o risco volta |
| Depois de marcar, *"não vou mais poder na sexta"* ouvia *"sem problema"* e a visita continuava marcada | 29/09 (006 FR-004g, depois 009) | "Proposta aberta" passou a ser uma linha ainda `proposed`; a 009 cancela de verdade, depois de perguntar |
| *"Pode ser domingo às 7?"* era lido como recusa (*"sem problema…"*) | 29/09 (009) | Uma mensagem que pede ou cita dia/horário não é recusa |
| *"Quem vai me atender?"* virava handoff ou *"ainda não consigo"* | 28/09 (006) | Fato `askedWhoAttends` e frase escrita pelo código |
| Pedidos de corretor por orientação sexual (*"queer"*, *"LGBT"*) nem sempre eram recusados | 28/09 (006) | Descrição do fato cita identidade de gênero e orientação sexual; recusa não conta como pedido de humano |
