# Capturas de tela

As imagens que o [README](../../README.md), os [requisitos](../requisitos.md) e as
[conversas de exemplo](../exemplos/conversas.md) mostram. São da aplicação rodando de verdade, com o banco de
demonstração e as conversas de exemplo (sessões `amostra2-*` e `amostra3-*`).

**Como refazer:** [`scripts/screenshots/`](../../scripts/screenshots/README.md) tira todas, ou só as que você
nomear, com o mesmo enquadramento. As conversas vêm de
[`scripts/sample-conversations/`](../../scripts/sample-conversations/README.md).

**Quando refazer.** Uma imagem desatualizada é uma afirmação falsa sobre o produto. Se uma mudança altera
algo da coluna "Refazer quando muda", refaça a imagem no mesmo commit. Se a mudança altera o que a Sofia
diz numa conversa de exemplo, refaça antes a conversa e o trecho em `docs/exemplos/conversas.md`.

| Arquivo | O que mostra | Refazer quando muda |
|---|---|---|
| `chat-compra.png` | Chat no celular, fim da conversa de compra (Camila): cartões de imóveis, pedido de contato, horários de visita e o cartão **Agendado** | O visual do widget (bolhas, cartões de imóvel, cartão de agendamento, campo de mensagem); as frases de oferta, de confirmação ou de pedido de imóvel; o roteiro de compra |
| `chat-compra-cartoes.png` | O início da mesma conversa: o roteiro de compra pergunta a pergunta, até os três cartões | O visual do widget e dos cartões; a ordem ou o texto das perguntas de compra; a releitura ("Só pra confirmar…") |
| `chat-investimento.png` | Conversa de investimento (Rafael): perfil, ticket, horários de **ligação com o especialista em investimentos**, confirmação e remarcação | O roteiro de investimento; as frases de oferta, confirmação e remarcação; quem a frase diz que atende |
| `chat-followup.png` | Conversa de aluguel (Marina) com o termo de consentimento no topo, a mensagem de **follow-up** e o lead voltando | O termo de consentimento; o texto ou o formato do follow-up; o widget |
| `chat-guardrails.png` | Guardrails (Pedro): recusa de *prompt injection*, previsão do tempo e desconto ("não consigo… quer que a equipe verifique?") e o pedido de corretor | Qualquer texto de recusa, fronteira ou passagem para humano; as regras de injeção |
| `painel-leads.png` | Lista de leads da gerente: indicadores (1ª resposta, qualificação, visitas, recuperados), filtros, temperatura, prévia e etiquetas de estado | Os indicadores, os filtros, a linha do lead, as etiquetas, o cabeçalho ou a navegação do painel |
| `painel-lead.png` | Painel do lead aberto sobre a lista (Camila): resumo da IA, tabela de qualificação e ações (assumir, mover, follow-up, transferir) | O painel do lead: seções, ações, rótulos da qualificação, o resumo |
| `painel-lead-investimento.png` | O mesmo painel para um investidor (Rafael): perfil, valor e expectativa de retorno | Os rótulos da qualificação de investimento; o painel do lead |
| `agenda.png` | Agenda da imobiliária: compromissos por dia, tipo (visita ou ligação), corretor responsável e ações (realizada, cancelar) | A página de agenda; quem é escolhido como corretor (a linha de Rafael mostra o especialista) |
| `catalogo.jpg` | Catálogo de imóveis com filtros e cartões | A página de catálogo ou os dados do seed |
| `langfuse-trace.png` | Um turno no Langfuse: `conversation.turn` com as gerações `model.extract`, `model.reply` e a ferramenta `tool.updateSlots`, latência, perfil do modelo | Os nomes ou a estrutura dos *spans*; o que vai para o Langfuse |

As fotos dos imóveis vêm do picsum.photos (aleatórias, por código) e não têm relação com o imóvel. Os leads
de teste do desenvolvedor aparecem na lista e na agenda: o banco de demonstração é o mesmo.
