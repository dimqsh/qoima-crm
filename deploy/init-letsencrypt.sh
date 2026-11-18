#!/bin/sh
set -eu

if [ ! -f .env ]; then
  echo "Missing .env. Copy deploy/.env.production.example to .env and fill secrets first." >&2
  exit 1
fi

set -a
. ./.env
set +a

# DOMAIN is the certificate name (nginx reads /etc/letsencrypt/live/$DOMAIN).
# CERT_DOMAINS are all names the certificate must cover.
DOMAIN="${DOMAIN:-crm.qoima.com.kz}"
CERT_DOMAINS="${CERT_DOMAINS:-crm.qoima.com.kz crm.si-automation.kz}"
EMAIL="${CERTBOT_EMAIL:-${DJANGO_SUPERUSER_EMAIL:-}}"
STAGING="${CERTBOT_STAGING:-0}"
RSA_KEY_SIZE="${CERTBOT_RSA_KEY_SIZE:-4096}"

if [ -z "$EMAIL" ]; then
  echo "CERTBOT_EMAIL is required in .env" >&2
  exit 1
fi

domain_args="-d $DOMAIN"
for name in $CERT_DOMAINS; do
  if [ "$name" != "$DOMAIN" ]; then
    domain_args="$domain_args -d $name"
  fi
done

if docker compose --env-file .env --profile certbot run --rm --entrypoint sh certbot -c "\
  test -f /etc/letsencrypt/live/$DOMAIN/fullchain.pem && \
  test -f /etc/letsencrypt/live/$DOMAIN/privkey.pem"; then
  san=$(docker compose --env-file .env --profile certbot run --rm --entrypoint sh certbot -c "\
    openssl x509 -in /etc/letsencrypt/live/$DOMAIN/fullchain.pem -noout -text" | grep -o 'DNS:[^,[:space:]]*' || true)
  missing=""
  for name in $CERT_DOMAINS; do
    if ! printf '%s\n' "$san" | grep -qxF "DNS:$name"; then
      missing="$missing $name"
    fi
  done

  if [ -n "$missing" ]; then
    echo "Certificate $DOMAIN does not cover:$missing. Expanding..."
    if docker compose --env-file .env --profile certbot run --rm certbot certonly \
      --webroot \
      --webroot-path /var/www/certbot \
      --email "$EMAIL" \
      --rsa-key-size "$RSA_KEY_SIZE" \
      --agree-tos \
      --no-eff-email \
      --non-interactive \
      --expand \
      --cert-name "$DOMAIN" \
      $domain_args; then
      docker compose --env-file .env exec nginx nginx -s reload || true
    else
      echo "WARNING: could not expand certificate; keeping the current one." >&2
    fi
    exit 0
  fi

  echo "Certificate for $DOMAIN already exists. Checking renewal..."
  docker compose --env-file .env --profile certbot run --rm certbot renew \
    --webroot \
    --webroot-path /var/www/certbot
  docker compose --env-file .env exec nginx nginx -s reload || true
  exit 0
fi

echo "Creating temporary certificate for $DOMAIN..."
docker compose --env-file .env --profile certbot run --rm --entrypoint sh certbot -c "\
  mkdir -p /etc/letsencrypt/live/$DOMAIN && \
  openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
    -keyout /etc/letsencrypt/live/$DOMAIN/privkey.pem \
    -out /etc/letsencrypt/live/$DOMAIN/fullchain.pem \
    -subj '/CN=localhost'"

echo "Starting nginx..."
docker compose --env-file .env up -d --build nginx

echo "Removing temporary certificate..."
docker compose --env-file .env --profile certbot run --rm --entrypoint sh certbot -c "\
  rm -rf /etc/letsencrypt/live/$DOMAIN && \
  rm -rf /etc/letsencrypt/archive/$DOMAIN && \
  rm -f /etc/letsencrypt/renewal/$DOMAIN.conf"

staging_arg=""
if [ "$STAGING" = "1" ]; then
  staging_arg="--staging"
fi

echo "Requesting Let's Encrypt certificate for $DOMAIN..."
docker compose --env-file .env --profile certbot run --rm certbot certonly \
  --webroot \
  --webroot-path /var/www/certbot \
  $staging_arg \
  --email "$EMAIL" \
  --rsa-key-size "$RSA_KEY_SIZE" \
  --agree-tos \
  --no-eff-email \
  --force-renewal \
  --non-interactive \
  --cert-name "$DOMAIN" \
  $domain_args

echo "Reloading nginx with real certificate..."
docker compose --env-file .env up -d --build nginx
docker compose --env-file .env exec nginx nginx -s reload

echo "HTTPS is ready for https://$DOMAIN"
