#!/bin/sh
# Makes sure every public domain is listed in the host/origin settings of .env.
# Idempotent: values that are already present are left alone.
set -eu

ENV_FILE="${1:-.env}"
DOMAINS="${DOMAINS:-crm.qoima.com.kz crm.si-automation.kz}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE" >&2
  exit 1
fi

add_value() {
  key="$1"
  value="$2"
  current=$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2-)
  case ",$current," in
    *",$value,"*) return 0 ;;
  esac

  if [ -z "$current" ]; then
    updated="$value"
  else
    updated="$current,$value"
  fi

  if grep -qE "^${key}=" "$ENV_FILE"; then
    tmp=$(mktemp)
    awk -v k="$key" -v v="$updated" \
      'index($0, k "=") == 1 { print k "=" v; next } { print }' "$ENV_FILE" > "$tmp"
    cat "$tmp" > "$ENV_FILE"
    rm -f "$tmp"
  else
    printf '\n%s=%s\n' "$key" "$updated" >> "$ENV_FILE"
  fi
  echo "$key: added $value"
}

for domain in $DOMAINS; do
  add_value DJANGO_ALLOWED_HOSTS "$domain"
  add_value CSRF_TRUSTED_ORIGINS "https://$domain"
  add_value CORS_ALLOWED_ORIGINS "https://$domain"
done
