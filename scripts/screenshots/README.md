# Capturas de tela

Refaz as imagens de [`docs/imagens/`](../../docs/imagens/README.md) com o mesmo enquadramento: chat em 430 px
de largura (escala 2×), painel em 1440 × 900 (escala 1,5×) e o Langfuse em 1600 × 1000.

Ferramenta de desenvolvimento, **só no host**. Usa o Google Chrome instalado (`CHROME_PATH` para outro) e o
`playwright-core`, que fica neste diretório e fora das dependências da aplicação. Precisa do Node 24.

```bash
cd scripts/screenshots && npm install
```

Com a pilha no ar (`docker compose --profile observability up -d`), todas as imagens:

```bash
node scripts/screenshots/shoot.mjs
```

Só algumas:

```bash
node scripts/screenshots/shoot.mjs painel-lead.png agenda.png
```

`shots.json` diz de onde vem cada imagem: a sessão do chat, a URL do painel ou o *trace* do Langfuse. O
login usa a gerente semeada (`carla@demo.com.br`, senha de desenvolvimento) e o usuário inicial do Langfuse
local, ambos de configuração local. Depois de refazer, olhe as imagens antes do commit: uma conversa que
mudou de tamanho pode cortar a parte que interessa (ajuste `height` ou `scrollTop`).
