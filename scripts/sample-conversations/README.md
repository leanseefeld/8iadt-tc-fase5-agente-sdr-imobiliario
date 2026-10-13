# Conversas de exemplo

Gera as conversas de [`docs/exemplos/conversas.md`](../../docs/exemplos/conversas.md) pela API do próprio chat
(`POST /api/chat`), como o widget faz, contra a aplicação local. Python 3, sem dependências.

As conversas da documentação foram geradas com o Gemma 4 12B: `MODEL_PROFILE=omlx_gemma4_12b` e
`MODEL_TIMEOUT_MS=120000` no `.env`, depois `docker compose up -d app worker`. Volte o `.env` ao fim.

```bash
python3 scripts/sample-conversations/drive.py scripts/sample-conversations/plan.json
```

Só alguns cenários (`compra`, `investimento`, `followup`, `aluguel-revisao`, `guardrails`):

```bash
python3 scripts/sample-conversations/drive.py scripts/sample-conversations/plan.json investimento
```

**Sessões novas para conversas novas.** O script continua de onde a sessão parou. Para refazer uma conversa
do zero, troque o `session` no `plan.json` (por exemplo `amostra3-…` para `amostra4-…`) e atualize o
`shots.json` das capturas.

**Follow-up.** O cenário para depois de duas mensagens. Abra o lead no painel, use **Enviar follow-up agora**
(ou **Enviar agora** na tela **Follow-ups**), espere o envio e rode de novo. O botão envia mesmo fora da janela de
envio da agência (spec 017).

Para copiar a conversa para a documentação, sem edição:

```bash
python3 scripts/sample-conversations/fmt.py amostra3-investimento-rafael
```
