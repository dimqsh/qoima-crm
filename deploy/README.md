# Qoima Deploy

This deployment uses one server, Docker Compose, and nginx.

## GitHub Secrets

Create these secrets in GitHub repository settings:

```text
DEPLOY_SSH_KEY=private SSH key for the ubuntu user
PRODUCTION_ENV_FILE=full contents of the production .env file
```

`DEPLOY_HOST` and `DEPLOY_USER` are optional because the workflow defaults to:

```text
DEPLOY_HOST=185.22.67.18
DEPLOY_USER=ubuntu
```

If `PRODUCTION_ENV_FILE` is empty, the workflow keeps the existing `.env` on
the server.

Do not store server passwords or production passwords in git.

## GitHub Variables

Optional repository variable:

```text
DEPLOY_PATH=/home/ubuntu/projects/qoima-crm
DEPLOY_PORT=22
```

## Deploy Flow

Every push to `main` runs `.github/workflows/deploy.yml`.

The workflow:

```bash
rsyncs the repository to /home/ubuntu/projects/qoima-crm
keeps the server .env unless PRODUCTION_ENV_FILE is set
docker compose --env-file .env up -d --build
python manage.py ensure_superuser
python manage.py set_telegram_webhook when Telegram env vars exist
docker compose --env-file .env restart backend frontend nginx
docker image prune -f
```

## Production .env

Use `deploy/.env.production.example` as the template for `PRODUCTION_ENV_FILE`.

Required superuser values:

```text
DJANGO_SUPERUSER_EMAIL=admin@example.com
DJANGO_SUPERUSER_USERNAME=admin
DJANGO_SUPERUSER_PASSWORD=strong-password
```

The deploy workflow runs:

```bash
docker compose --env-file .env up -d --build
docker compose --env-file .env exec -T backend python manage.py ensure_superuser
docker compose --env-file .env restart backend frontend nginx
```

## Manual Deploy On Server

```bash
cd /home/ubuntu/projects/qoima-crm
cp deploy/.env.production.example .env
# edit .env
docker compose --env-file .env up -d --build
```

## HTTPS Setup

The production domain is `crm.si-automation.kz` (it replaced
`crm.qoima.com.kz`, which no longer resolves). Its DNS A record must point to
`185.22.67.18`, and ports `80` and `443` must be open on the server.

The certificate is stored as `crm.si-automation.kz`. To add another domain,
put it in:

- `server_name` in `nginx/default.conf` (both server blocks)
- `CERT_DOMAINS` in `deploy/init-letsencrypt.sh`
- `DOMAINS` in `deploy/ensure-env-domains.sh`

The deploy workflow adds it to `DJANGO_ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS`
and `CORS_ALLOWED_ORIGINS` in the server `.env` and expands the certificate.

On the first deployment, issue the Let's Encrypt certificate:

```bash
cd /home/ubuntu/projects/qoima-crm
chmod +x deploy/init-letsencrypt.sh
./deploy/init-letsencrypt.sh
```

After the first certificate is issued, normal deploys can use:

```bash
docker compose --env-file .env up -d --build
```

Renew certificates periodically with:

```bash
./deploy/init-letsencrypt.sh
```

## Telegram Webhook

The production Telegram webhook endpoint is:

```text
https://crm.si-automation.kz/api/telegram/webhook/
```

Set this value in `.env`:

```text
TELEGRAM_WEBHOOK_URL=https://crm.si-automation.kz/api/telegram/webhook/
```

Register or refresh the Telegram webhook with:

```bash
docker compose --env-file .env exec -T backend python manage.py set_telegram_webhook
```
