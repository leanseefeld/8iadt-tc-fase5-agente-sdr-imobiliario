# `reference/` — ideação, não especificação

> **Esta pasta NÃO é normativa.** Nada aqui deve ser citado como requisito técnico.

## O que é isto

Material de ideação escrito **antes** de a stack do projeto ser escolhida. Os
documentos descrevem um sistema em **Python + FastAPI + API da Anthropic** que
**não será construído**. A implementação real usa Next.js, TypeScript, Vercel AI
SDK e um provedor compatível com OpenAI.

Estes arquivos **não são mantidos em sincronia com o código**. Espera-se que
divirjam da implementação ao longo do tempo, e isso é aceitável — eles registram o
raciocínio inicial, não o estado atual do sistema.

## Para que serve

Continua sendo material útil para:

- **Intenção de produto** — que problema a solução resolve e para quem
- **Jornadas de usuário** — os pontos de interação do lead, do corretor e do gerente
- **Esboços de telas** — as seis telas desenhadas para o MVP
- **Narrativa do pitch** — o argumento comercial e o contexto de mercado
- **Exemplos de conversa** — roteiro para a demonstração ao vivo

## Para que NÃO serve

- Decisões de stack, biblioteca ou infraestrutura
- Estrutura de pastas, camadas ou nomes de módulos
- Modelo de dados, contratos de API ou assinaturas de função
- Qualquer coisa que um agente de código deva implementar literalmente

## Onde está a arquitetura de verdade

| Documento | Conteúdo |
|---|---|
| [`../.specify/memory/constitution.md`](../.specify/memory/constitution.md) | Regras inegociáveis do projeto |
| [`../docs/arquitetura/visao-geral.md`](../docs/arquitetura/visao-geral.md) | Arquitetura real e estrutura do projeto |
| [`../docs/arquitetura/adr/decisoes.md`](../docs/arquitetura/adr/decisoes.md) | Decisões técnicas e suas consequências |
| [`../docs/decisoes-pendentes.md`](../docs/decisoes-pendentes.md) | O que ainda não foi decidido |
| [`../specs/BACKLOG.md`](../specs/BACKLOG.md) | Fatias de trabalho e rastreabilidade |

## Conteúdo desta pasta

| Arquivo | Descrição |
|---|---|
| `Desafio - Agente SDR Imobiliario.md` | Enunciado original do Tech Challenge (este **é** a fonte dos requisitos de negócio) |
| `arquitetura e visão.md` | Ensaio inicial de arquitetura, mercado e diferenciais |
| `mvp - telas e arquitetura.md` | Desenho do MVP: pontos de interação, telas e arquitetura proposta |
| `exemplos de conversas.md` | Conversas de exemplo para os três cenários |
| `ideas.md` | Anotações soltas |

> Exceção: o enunciado do desafio é a fonte legítima dos **requisitos de negócio**.
> O que não vale é tratar as decisões **técnicas** dos outros documentos como
> especificação.
