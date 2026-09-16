# Evals

Quanto o agente acerta ao **ler** a mensagem de um lead, medido em número em vez
de anedota.

```bash
docker compose exec -T app node evals/extraction.mjs --runs 8
docker compose exec -T app node evals/extraction.mjs --prompt-file evals/candidato.txt
```

Sai um placar por caso, e cada resposta crua do modelo vai para
`evals/last-run.jsonl` — um número estranho se lê, não se discute.

| Arquivo | O quê |
|---|---|
| `extraction-cases.json` | Os casos e seus rótulos. É o contrato desta eval. |
| `extraction.mjs` | Roda e pontua. Não contém rótulo nenhum. |

## Por que existe

A extração é o único ponto do turno em que um *sampler* decide se o agente
entendeu uma pessoa. Trocar o prompt, o formato de resposta ou o provedor muda
esse número, e ninguém percebe pela conversa — percebe pelo lead que foi
atendido como comprador porque riu.

Cada caso carrega **a conversa que veio antes dele**. Metade das mensagens reais
não significa nada sozinha: `"2"` e `"inicial"` só têm sentido depois da pergunta
que o roteiro acabou de fazer.

Um caso só passa se o estado final for exatamente o do rótulo: todo valor
esperado presente **e nada além disso preenchido**. A segunda metade é a que pega
invenção, então não é opcional. Por isso cada caso declara o que o turno já sabia
(`known`): a extração repete o que já conhece o tempo todo, e `mergeSlots` ignora
— repetir não é erro, contradizer é.

Um caso que acerta às vezes conta como falha. O lead tem um turno só.

## O que estas medições já decidiram

**O formato da chamada.** A extração era uma chamada de chat com três ferramentas
e `toolChoice: "required"`. Em 53 chamadas reais, **38% voltaram como prosa e
nenhuma ferramenta** — o modelo respondendo à pessoa em vez de ler a mensagem.
Mandar um *JSON schema* foi pior: o oMLX aceita e depois não restringe o modelo a
ele — a maioria das respostas veio como um `["zona sul"]` solto até estourar o
limite de tokens. Em `temperature: 0` isso acontecia em **todas** as chamadas, e
foi essa determinação que denunciou o problema como do decodificador, não da
amostragem. Modo JSON simples, com o guia de campos no prompt, acertou 30 de 30.

Detalhe que custou caro: o zod gera campos anuláveis como `anyOf`, que esse
decodificador ignora por completo. O schema é escrito à mão por isso.

**As palavras do prompt.** `"kkkk"` virava `intent: "purchase"` e *"se eu quisesse
alugar, vocês teriam algo?"* virava `rental`. Os dois sistemáticos, 0 em 8, e os
dois caros: `intent` é imutável, então uma piada prendia a pessoa no roteiro
errado. A culpa era de uma instrução bem-intencionada — *"quem procura imóvel sem
dizer a finalidade está comprando"* — que o modelo aplicava a qualquer mensagem.
Nomear o que **não** é resposta (risada, provocação, ironia, pergunta, hipótese)
levou de 128/144 para 142/144.

A ordem pesou mais que a redação: uma versão que começava pela cautela parou de
ler `"na zona sul"`. O prompt começa pelo que **deve** registrar; as recusas vêm
depois.

**A trava de evidência.** O modelo preenche campos de conjunto fechado sobre
assuntos que ninguém levantou (`urgency: "exploring"` para quem nunca falou de
prazo). Instrução sozinha reduziu pela metade e não resolveu, então uma lista de
palavras em `domain/slots.ts` decide. Testamos deixar o próprio modelo justificar
— listando os campos mencionados, ou citando o trecho exato, verificado em
código. Em 80 rodadas com os três julgando a **mesma** saída, nenhum dos três
inventou nada; o modelo recusou valores legítimos **2,5× mais**, inclusive o
`"inicial"` que já tinha causado bug. Ficou a lista.

A trava é dispensada para o campo que o roteiro acabou de perguntar: quem
responde `"inicial"` está ecoando a pergunta, e nenhuma lista de palavras conterá
o vocabulário de todas as perguntas.

## Limites conhecidos

- A eval faz **uma** chamada por rodada; a produção tem uma nova tentativa. Os ~2%
  de respostas ilegíveis que aparecem aqui a produção absorve.
- Os rótulos são julgamento humano, revisáveis em `extraction-cases.json`.
- Mede a extração, não a conversa inteira. Os cenários ponta a ponta são testes de
  integração da spec 004.
