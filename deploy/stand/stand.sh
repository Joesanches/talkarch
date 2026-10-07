#!/usr/bin/env bash
# Тестовый стенд «Консилиума»: чат, чаты случаев, звонки, песочница РИС/ЛИС.
# Подробности — deploy/stand/README.md.
set -euo pipefail
shopt -u patsub_replacement 2>/dev/null || true
cd "$(dirname "$0")"

ENV_FILE=.env
GEN=generated
compose() { docker compose --env-file "$ENV_FILE" "$@"; }

rand() { head -c 48 /dev/urandom | sha256sum | cut -c1-"${1:-40}"; }
sha() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
die() { echo "Ошибка: $*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Использование: ./stand.sh <команда>

  init <домен> [email]   Сгенерировать секреты и конфигурацию (повторный запуск сохраняет секреты)
  up                     Собрать образы и запустить стенд
  users                  Создать демо-пользователей и показать пароль
  add-user <логин> "<Имя Ф. О.>"   Учётная запись для тестировщика (пароль покажет команда)
  tokens                 Токены подключений для команды РИС/ЛИС
  ca                     Корневой сертификат Caddy (режим TLS_MODE=internal)
  status | logs [сервис] | down | destroy

Переменные для init: TLS_MODE=internal — свой сертификат вместо Let's Encrypt;
NODE_IP=<адрес> — адрес для медиа звонков, если автоопределение не подходит.
USAGE
}

render() { # render <шаблон> <файл>
  local src=templates/$1 dst=$GEN/$2 content
  content=$(<"$src")
  for var in DOMAIN DOMAIN_RE PG_PASSWORD REG_SECRET MACAROON_SECRET FORM_SECRET AS_TOKEN HS_TOKEN ALIAS_SECRET \
    LIVEKIT_KEY LIVEKIT_SECRET LIVEKIT_IP LIS_TOKEN LIS_TOKEN_SHA RIS_TOKEN RIS_TOKEN_SHA TEAM_TOKEN_SHA \
    LIS_CALLBACK_TOKEN DEMO_PASSWORD; do
    content=${content//"__${var}__"/"${!var}"}
  done
  printf '%s\n' "$content" >"$dst"
}

cmd_init() {
  local domain=${1:-} email=${2:-}
  [[ -n $domain ]] || die "укажите домен: ./stand.sh init chat-test.example.ru admin@example.ru"
  if [[ -f $ENV_FILE ]]; then
    # shellcheck disable=SC1090
    set -a; . "./$ENV_FILE"; set +a
    if [[ ${DOMAIN:-} != "$domain" ]]; then
      echo "Внимание: домен меняется с ${DOMAIN:-?} на $domain. Synapse не поддерживает смену имени сервера —" >&2
      echo "для нового домена выполните ./stand.sh destroy и init заново." >&2
      exit 1
    fi
  fi
  DOMAIN=$domain
  ACME_EMAIL=${email:-${ACME_EMAIL:-}}
  TLS_MODE=${TLS_MODE:-acme}
  NODE_IP=${NODE_IP:-}
  PG_PASSWORD=${PG_PASSWORD:-$(rand 32)}
  REG_SECRET=${REG_SECRET:-$(rand 48)}
  MACAROON_SECRET=${MACAROON_SECRET:-$(rand 48)}
  FORM_SECRET=${FORM_SECRET:-$(rand 48)}
  AS_TOKEN=${AS_TOKEN:-$(rand 48)}
  HS_TOKEN=${HS_TOKEN:-$(rand 48)}
  ALIAS_SECRET=${ALIAS_SECRET:-$(rand 48)}
  LIVEKIT_KEY=${LIVEKIT_KEY:-stand$(rand 8)}
  LIVEKIT_SECRET=${LIVEKIT_SECRET:-$(rand 48)}
  LIS_TOKEN=${LIS_TOKEN:-lis-$(rand 40)}
  RIS_TOKEN=${RIS_TOKEN:-ris-$(rand 40)}
  TEAM_TOKEN=${TEAM_TOKEN:-team-$(rand 40)}
  LIS_CALLBACK_TOKEN=${LIS_CALLBACK_TOKEN:-cb-$(rand 40)}
  DEMO_PASSWORD=${DEMO_PASSWORD:-$(rand 14)}

  umask 077
  cat >"$ENV_FILE" <<ENV
# Секреты стенда — не коммитить. Сгенерировано ./stand.sh init $(date -u +%Y-%m-%dT%H:%MZ).
DOMAIN=$DOMAIN
ACME_EMAIL=$ACME_EMAIL
TLS_MODE=$TLS_MODE
NODE_IP=$NODE_IP
PG_PASSWORD=$PG_PASSWORD
REG_SECRET=$REG_SECRET
MACAROON_SECRET=$MACAROON_SECRET
FORM_SECRET=$FORM_SECRET
AS_TOKEN=$AS_TOKEN
HS_TOKEN=$HS_TOKEN
ALIAS_SECRET=$ALIAS_SECRET
LIVEKIT_KEY=$LIVEKIT_KEY
LIVEKIT_SECRET=$LIVEKIT_SECRET
LIS_TOKEN=$LIS_TOKEN
RIS_TOKEN=$RIS_TOKEN
TEAM_TOKEN=$TEAM_TOKEN
LIS_CALLBACK_TOKEN=$LIS_CALLBACK_TOKEN
DEMO_PASSWORD=$DEMO_PASSWORD
# Корневой сертификат корпоративного прокси для сборки образов (если сеть подменяет TLS).
BUILD_CA_FILE=${BUILD_CA_FILE:-}
ENV

  DOMAIN_RE=${DOMAIN//./\\.}
  LIS_TOKEN_SHA=$(sha "$LIS_TOKEN")
  RIS_TOKEN_SHA=$(sha "$RIS_TOKEN")
  TEAM_TOKEN_SHA=$(sha "$TEAM_TOKEN")
  if [[ -n $NODE_IP ]]; then
    LIVEKIT_IP=$'  node_ip: '"$NODE_IP"$'\n  use_external_ip: false'
  else
    LIVEKIT_IP='  use_external_ip: true'
  fi

  mkdir -p "$GEN/synapse"
  render homeserver.yaml synapse/homeserver.yaml
  render appservice-ccs.yaml synapse/appservice-ccs.yaml
  render log.yaml synapse/log.yaml
  render livekit.yaml livekit.yaml
  render connectors.json connectors.json
  render ccs.env ccs.env
  render host-mock.env host-mock.env
  umask 022
  render config.json config.json
  if [[ -n $ACME_EMAIL ]]; then echo "email $ACME_EMAIL" >"$GEN/caddy-global.caddy"; else echo "# email для ACME не задан" >"$GEN/caddy-global.caddy"; fi
  # Synapse в контейнере читает конфигурацию от своего пользователя.
  chmod 644 "$GEN"/synapse/* "$GEN"/livekit.yaml "$GEN"/connectors.json "$GEN"/config.json "$GEN"/caddy-global.caddy
  echo "Конфигурация для https://$DOMAIN готова (секреты — в deploy/stand/$ENV_FILE). Дальше: ./stand.sh up"
}

need_init() { [[ -f $ENV_FILE && -d $GEN ]] || die "сначала ./stand.sh init <домен>"; set -a; . "./$ENV_FILE"; set +a; }

cmd_up() {
  need_init
  # --force-recreate: изменения конфигурации (повторный init) применяются сразу; данные — в томах.
  compose up -d --build --wait --force-recreate
  echo
  echo "Стенд работает: https://$DOMAIN"
  echo "Демо-пользователи: ./stand.sh users. Ссылка на чат случая: https://$DOMAIN/c/lis/Г26-04512"
}

run_users() { compose run --rm --no-deps host-mock node --import tsx apps/host-mock/src/users.ts "$@"; }

cmd_users() {
  need_init
  run_users
  cat <<TXT

Вход: https://$DOMAIN — логин из списка выше, пароль: $DEMO_PASSWORD
  smirnova   патоморфолог      ershova    лаборант ИГХ      kolesnikov лечащий врач
  gusev      заведующий (вход по требованию через ЛИС)
  orlov      рентгенолог       safonova   рентгенолаборант  melnikova  дежурный врач
  belova     доступ к случаю РИС по списку     outsider   без доступа
Чаты случаев: https://$DOMAIN/c/lis/Г26-04512  ·  https://$DOMAIN/c/ris/A26-118734
TXT
}

cmd_tokens() {
  need_init
  cat <<TXT
API интеграции: https://$DOMAIN/integration/v1  (docs/10-integration-api.md)
  team — РИС/ЛИС команды разработки (уровень 1): $TEAM_TOKEN
  lis  — песочница ЛИС:  $LIS_TOKEN
  ris  — песочница РИС:  $RIS_TOKEN
Проверка: curl -H "authorization: Bearer $TEAM_TOKEN" https://$DOMAIN/integration/v1/connector
TXT
}

case ${1:-help} in
  init) shift; cmd_init "$@" ;;
  up) cmd_up ;;
  users) cmd_users ;;
  add-user) need_init; shift; [[ $# -ge 1 ]] || die 'укажите логин и имя: ./stand.sh add-user ivanov "Иванов И. И."'; run_users add "$@" ;;
  tokens) cmd_tokens ;;
  ca) need_init; compose exec -T web cat /data/caddy/pki/authorities/local/root.crt ;;
  status) need_init; compose ps ;;
  logs) need_init; shift; compose logs -f --tail=200 "$@" ;;
  down) need_init; compose down ;;
  destroy)
    need_init
    read -r -p "Удалить стенд вместе с данными (переписка, пользователи, сертификаты)? Введите домен для подтверждения: " answer
    [[ $answer == "$DOMAIN" ]] || die "не подтверждено"
    compose down -v
    rm -rf "$GEN" "$ENV_FILE"
    echo "Стенд удалён." ;;
  *) usage ;;
esac
