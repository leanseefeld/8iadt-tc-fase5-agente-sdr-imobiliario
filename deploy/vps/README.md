# Produção num servidor só (VPS ou VM na Azure)

Um servidor, Docker Compose, a mesma imagem `runner` do `Dockerfile`. É o
`docker compose up` do desenvolvimento, sem bind mount e com HTTPS na frente. O
porquê, os custos e a comparação estão em
[`docs/exploracoes/hospedagem.md`](../../docs/exploracoes/hospedagem.md).

O endereço é **`https://sofia.nomadmacaw.com`**. O domínio fica no Route 53.

> **Exercitado localmente, não num servidor real.** Em 11 e 13/10/2026 a pilha subiu
> num contêiner com `DOMAIN=localhost` (certificado interno do Caddy), com a imagem
> amd64 e com a arm64 (esta sob emulação QEMU). Nos dois casos: migrate, app e worker
> saudáveis, seed, login, uma conversa por SSE atravessando o Caddy sem buffer, e a
> campainha do worker. Let's Encrypt, firewall e backup só se verificam no servidor.

## O que sobe

| Serviço | O que é | Memória medida em repouso (amd64) |
|---|---|---|
| `caddy` | HTTPS (Let's Encrypt), proxy para o app. Única porta publicada: 80/443 | 13 MiB |
| `app` | Next.js, `node server.js` | 60 MiB |
| `worker` | `node dist/worker/index.js`: varredura periódica e a campainha do *Enviar agora* | 42 MiB |
| `db` | Postgres 17, volume `pgdata`, sem porta publicada | 38 MiB |
| `migrate` | `node dist/db/migrate.js`, roda e sai antes de app e worker | — |
| `seed` | `node dist/db/seed/index.js`, só com `docker compose run --rm seed` | — |

Cerca de 150 MiB no total. Uma máquina de 1 GB comporta a pilha, mas **não** o
`next build`: a imagem é construída no GitHub Actions, nunca no servidor.

## A imagem

`.github/workflows/image.yml` publica `ghcr.io/leanseefeld/8iadt-tc-fase5-agente-sdr-imobiliario`
a cada push no `main`, com as tags `:latest` e `:sha-<commit curto>`, para **amd64 e
arm64** na mesma tag. O Docker do servidor baixa a variante da própria arquitetura.
Use a tag `sha-…` no `.env`: assim se sabe o que está no ar, e voltar atrás é trocar
uma linha.

O pacote nasce **privado** no GHCR. Para não precisar de login no servidor, deixe-o
público (no GitHub: *Packages* → o pacote → *Package settings* → *Change visibility*).
O repositório já é público. Se preferir mantê-lo privado, faça
`docker login ghcr.io` no servidor com um token que tenha só `read:packages`.

## 1. O servidor

### Opção A: VM na Azure

O menor tamanho que comporta a pilha tem 1 GiB e 2 vCPUs. Há duas versões:

| Tamanho | Arquitetura | East US 2 | Brazil South |
|---|---|---|---|
| `Standard_B2pts_v2` | **arm64** (Ampere) | US$ 6,13/mês | não oferecido |
| `Standard_B2ats_v2` | amd64 (AMD) | US$ 6,86/mês | US$ 11,02/mês |

A imagem é multi-arquitetura, então os dois servem sem mudar nada. Os dois entram nas
750 h/mês da conta gratuita da Azure (12 meses). Custo total e comparação estão em
`hospedagem.md` §6.

> Comandos escritos contra a documentação da CLI `az`, não executados nesta
> assinatura. Conferir no primeiro uso.

```bash
RG=sofia; LOC=eastus2
SIZE=Standard_B2pts_v2                        # ou Standard_B2ats_v2 (amd64)
IMAGE=Canonical:ubuntu-24_04-lts:server-arm64:latest   # amd64: Canonical:ubuntu-24_04-lts:server:latest
MEU_IP=$(curl -s https://ifconfig.me)

az group create -n $RG -l $LOC
az vm create -g $RG -n sofia-vm --size $SIZE --image $IMAGE \
  --admin-username sofia --ssh-key-values ~/.ssh/id_ed25519.pub \
  --public-ip-sku Standard --public-ip-address-allocation static \
  --os-disk-size-gb 32 --storage-sku StandardSSD_LRS \
  --nsg-rule NONE
NSG=sofia-vmNSG
az network nsg rule create -g $RG --nsg-name $NSG -n ssh   --priority 100 \
  --destination-port-ranges 22 --source-address-prefixes $MEU_IP/32 --access Allow --protocol Tcp
az network nsg rule create -g $RG --nsg-name $NSG -n web   --priority 110 \
  --destination-port-ranges 80 443 --access Allow --protocol '*'
az vm show -d -g $RG -n sofia-vm --query publicIps -o tsv   # o IP para o Route 53
```

Na Azure, o firewall é o NSG acima. O `ufw` do passo 2 vira uma segunda camada,
opcional. **Para não gastar quando parar de usar:** `az vm deallocate` interrompe a
cobrança da VM (disco e IP continuam, ~US$ 6/mês), e `az group delete -n sofia` apaga
tudo. Antes, faça o backup.

### Opção B: VPS no Brasil

Qualquer Ubuntu ou Debian com 1 GB ou mais (opções em `hospedagem.md` §5.2). O
firewall é o `ufw` do passo 2.

## 2. Preparar o servidor

Como root (`sudo -i`):

```bash
curl -fsSL https://get.docker.com | sh

# Logs do Docker com teto (o padrão cresce sem limite)
cat > /etc/docker/daemon.json <<'EOF'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
EOF
systemctl restart docker

# Swap de 2 GB: com 1 GiB de RAM, é a folga contra um pico de memória
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Atualizações automáticas e, na VPS, o firewall
apt-get install -y ufw unattended-upgrades
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp && ufw --force enable
```

Desligar login por senha no SSH (`PasswordAuthentication no` em
`/etc/ssh/sshd_config`) se o provedor não fizer isso por padrão. A VM da Azure criada
com `--ssh-key-values` já vem só com chave.

## 3. DNS no Route 53

Na zona `nomadmacaw.com`, crie um registro **`A`** para `sofia` com o IP público do
servidor e TTL de 300 s. O Caddy só consegue o certificado depois que
`sofia.nomadmacaw.com` resolve para o servidor, e a porta 80 precisa estar aberta: a
validação do Let's Encrypt passa por ela.

```bash
dig +short sofia.nomadmacaw.com   # tem de devolver o IP do servidor
```

## 4. Subir

Copie `compose.yml` e `Caddyfile` para `/opt/sofia/` e crie `/opt/sofia/.env`. É o
contrato de `.env.example`, mais três chaves que só existem aqui:

```bash
IMAGE=ghcr.io/leanseefeld/8iadt-tc-fase5-agente-sdr-imobiliario:sha-<commit>
DOMAIN=sofia.nomadmacaw.com
POSTGRES_PASSWORD=<openssl rand -base64 24>
DATABASE_URL=postgresql://sdr:<a mesma senha>@db:5432/sdr
NODE_ENV=production
AUTH_SECRET=<openssl rand -base64 32>
MODEL_PROFILE=azure_nano
AZURE_OPENAI_BASE_URL=...
AZURE_OPENAI_API_KEY=...
FOLLOWUP_FIRST_DELAY_MINUTES=240
LANGFUSE_PUBLIC_KEY=...                  # Langfuse Cloud, opcionais
LANGFUSE_SECRET_KEY=...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
```

```bash
chmod 600 .env
docker compose up -d
docker compose run --rm seed     # só se quiser a agência demo
curl -s https://sofia.nomadmacaw.com/api/health/ready
```

O widget da agência demo fica em `https://sofia.nomadmacaw.com/chat/demo`, e o painel
em `https://sofia.nomadmacaw.com/login`.

## Deploy

```bash
cd /opt/sofia
sed -i "s|^IMAGE=.*|IMAGE=ghcr.io/leanseefeld/8iadt-tc-fase5-agente-sdr-imobiliario:sha-<novo>|" .env
docker compose pull && docker compose up -d
```

`up -d` roda o `migrate` de novo antes de recriar app e worker. As migrations do
Drizzle são idempotentes. A troca leva alguns segundos de indisponibilidade, o que é
aceitável sem SLA. Para voltar atrás, use a tag anterior.

## Backup

Sem banco gerenciado, o backup é responsabilidade nossa. Um cron diário no host:

```bash
# /etc/cron.d/sofia-backup
15 3 * * * root cd /opt/sofia && docker compose exec -T db pg_dump -U sdr -Fc sdr > /var/backups/sofia-$(date +\%F).dump && find /var/backups -name 'sofia-*.dump' -mtime +14 -delete
```

E uma cópia **fora** do servidor: Azure Blob Storage, Backblaze B2, Cloudflare R2 ou
outro S3, com `rclone`. Um backup que só existe no mesmo disco não sobrevive à perda
do servidor. Restaurar uma vez para provar que funciona:
`docker compose exec -T db pg_restore -U sdr -d sdr --clean < arquivo.dump`.

O mesmo `pg_dump` leva os dados de um servidor para outro, por exemplo da VM da Azure
para uma VPS no Brasil quando os créditos acabarem.

## Monitoramento

Um verificador externo gratuito (UptimeRobot ou similar) em
`https://sofia.nomadmacaw.com/api/health/ready`, com alerta por e-mail. O
`docker compose ps` mostra a saúde de app e worker pelos *healthchecks*.
