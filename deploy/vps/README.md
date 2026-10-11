# Produção numa VPS

Um servidor, Docker Compose, a mesma imagem `runner` do `Dockerfile`. É o
`docker compose up` do desenvolvimento, sem bind mount e com HTTPS na frente. O
porquê e a comparação com a Azure estão em
[`docs/exploracoes/hospedagem.md`](../../docs/exploracoes/hospedagem.md).

> **Exercitado localmente, não numa VPS real.** Em 11/10/2026 a pilha subiu num
> contêiner com `DOMAIN=localhost` (certificado interno do Caddy): migrate, app e
> worker saudáveis, seed, e uma conversa por SSE atravessando o Caddy sem buffer.
> Let's Encrypt, firewall e backup só se verificam no servidor.

## O que sobe

| Serviço | O que é | Memória medida em repouso |
|---|---|---|
| `caddy` | HTTPS (Let's Encrypt), proxy para o app. Única porta publicada: 80/443 | 13 MiB |
| `app` | Next.js, `node server.js` | 60 MiB |
| `worker` | `node dist/worker/index.js`, varredura a cada `WORKER_SWEEP_INTERVAL_MS` | 42 MiB |
| `db` | Postgres 17, volume `pgdata`, sem porta publicada | 38 MiB |
| `migrate` | `node dist/db/migrate.js`, roda e sai antes de app e worker | — |
| `seed` | `node dist/db/seed/index.js`, só com `docker compose run --rm seed` | — |

Cerca de 150 MiB no total. Uma VPS de 1 GB comporta a pilha, mas **não** o
`next build`: a imagem é construída no CI, nunca no servidor.

## Primeira vez

No servidor (Ubuntu ou Debian), como root:

```bash
# Docker e o plugin compose
curl -fsSL https://get.docker.com | sh

# Logs do Docker com teto (o padrão cresce sem limite)
cat > /etc/docker/daemon.json <<'EOF'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
EOF
systemctl restart docker

# Firewall: SSH e HTTP(S), nada mais
apt-get install -y ufw unattended-upgrades
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp && ufw --force enable
```

Desligar login por senha no SSH (`PasswordAuthentication no` em
`/etc/ssh/sshd_config`) depois de copiar a chave.

**DNS (Route 53):** registro `A` de `app.<domínio>` para o IP da VPS. O Caddy só
consegue o certificado depois que o nome resolve.

**Arquivos:** copiar `compose.yml` e `Caddyfile` para `/opt/sdr/` e criar
`/opt/sdr/.env`. É o contrato de `.env.example`, mais três chaves que só existem aqui:

```bash
IMAGE=ghcr.io/<owner>/sdr-imobiliario:<tag>
DOMAIN=app.<domínio>
POSTGRES_PASSWORD=<openssl rand -base64 24>
DATABASE_URL=postgresql://sdr:<a mesma senha>@db:5432/sdr
NODE_ENV=production
AUTH_SECRET=<openssl rand -base64 32>
MODEL_PROFILE=azure_nano
AZURE_OPENAI_BASE_URL=...
AZURE_OPENAI_API_KEY=...
FOLLOWUP_FIRST_DELAY_MINUTES=240
# LANGFUSE_* opcionais (Langfuse Cloud)
```

`chmod 600 .env`. Depois:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <owner> --password-stdin   # token com read:packages
docker compose up -d
docker compose run --rm seed     # só se quiser a agência demo
```

## Deploy

A imagem é construída e publicada pelo CI (ou à mão, com
`docker build --platform linux/amd64 --target runner` num Mac com Apple Silicon).
No servidor:

```bash
sed -i "s|^IMAGE=.*|IMAGE=ghcr.io/<owner>/sdr-imobiliario:<nova-tag>|" .env
docker compose pull && docker compose up -d
```

`up -d` roda o `migrate` de novo antes de recriar app e worker. As migrations do
Drizzle são idempotentes. Sem a etapa de build no servidor, a troca leva alguns
segundos de indisponibilidade, o que é aceitável sem SLA.

**Sem registro:** `docker save <imagem> | ssh vps docker load` também funciona e
dispensa o GHCR.

## Backup

Sem banco gerenciado, o backup é responsabilidade nossa. Um cron diário no host:

```bash
# /etc/cron.d/sdr-backup
15 3 * * * root cd /opt/sdr && docker compose exec -T db pg_dump -U sdr -Fc sdr > /var/backups/sdr-$(date +\%F).dump && find /var/backups -name 'sdr-*.dump' -mtime +14 -delete
```

E uma cópia **fora** da VPS (Backblaze B2, Cloudflare R2 ou outro S3, com `rclone`).
Um backup que só existe no mesmo disco não sobrevive à perda do servidor.
Restaurar uma vez para provar que funciona:
`docker compose exec -T db pg_restore -U sdr -d sdr --clean < arquivo.dump`.

## Monitoramento

Um verificador externo gratuito (UptimeRobot ou similar) em
`https://app.<domínio>/api/health/ready`, com alerta por e-mail. `docker compose ps`
mostra a saúde de app e worker pelos *healthchecks*.
