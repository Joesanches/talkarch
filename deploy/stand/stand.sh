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
NODE_IP=<адрес> — адрес для медиа звонков, если автоопределение не подходит;
EMBED_ORIGINS="https://ris.example.ru …" — страницы РИС/ЛИС, которым можно встраивать чат;
SSO=off — без единого входа через Keycloak (по умолчанию он есть: +1 ГБ ОЗУ);
AI=cpu — ИИ-«Секретарь» (стенограмма звонка и черновик протокола) на процессоре: +8 ГБ ОЗУ, +10 ГБ диска;
LLM_URL=… LLM_MODEL=… — внешний OpenAI-совместимый ИИ-шлюз вместо LLM на стенде (с AI=cpu);
ARCHIVE_AFTER_DAYS=0 — закрытые случаи уходят в архив в течение минуты (по умолчанию — через 14 дней без активности).
USAGE
}

render() { # render <шаблон> <файл>
  local src=templates/$1 dst=$GEN/$2 content
  content=$(<"$src")
  for var in DOMAIN DOMAIN_RE PG_PASSWORD REG_SECRET MACAROON_SECRET FORM_SECRET AS_TOKEN HS_TOKEN ALIAS_SECRET \
    LIVEKIT_KEY LIVEKIT_SECRET LIVEKIT_IP LIS_TOKEN LIS_TOKEN_SHA RIS_TOKEN RIS_TOKEN_SHA TEAM_TOKEN_SHA \
    LIS_CALLBACK_TOKEN DEMO_PASSWORD EMBED_ORIGINS_JSON AI_ENV OIDC_SECRET OIDC_YAML ARCHIVE_AFTER_DAYS; do
    content=${content//"__${var}__"/"${!var}"}
  done
  printf '%s\n' "$content" >"$dst"
}

cmd_init() {
  local domain=${1:-} email=${2:-}
  [[ -n $domain ]] || die "укажите домен: ./stand.sh init chat-test.example.ru admin@example.ru"
  # Заданное в командной строке (NODE_IP=… AI=cpu ./stand.sh init …) важнее сохранённого в .env.
  local overrides=() v
  for v in TLS_MODE NODE_IP EMBED_ORIGINS AI SSO LLM_URL LLM_MODEL BUILD_CA_FILE ARCHIVE_AFTER_DAYS; do
    [[ -n ${!v+x} ]] && overrides+=("$v=${!v}")
  done
  if [[ -f $ENV_FILE ]]; then
    # shellcheck disable=SC1090
    set -a; . "./$ENV_FILE"; set +a
    for v in "${overrides[@]}"; do export "${v%%=*}=${v#*=}"; done
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
  EMBED_ORIGINS=${EMBED_ORIGINS:-}
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
  AI=${AI:-off}
  [[ $AI == off || $AI == cpu ]] || die "AI=off или AI=cpu"
  SECRETARY_TOKEN=${SECRETARY_TOKEN:-$(rand 48)}
  LLM_URL=${LLM_URL:-}
  LLM_MODEL=${LLM_MODEL:-}
  SSO=${SSO:-keycloak}
  [[ $SSO == keycloak || $SSO == off ]] || die "SSO=keycloak или SSO=off"
  OIDC_SECRET=${OIDC_SECRET:-$(rand 48)}
  KC_ADMIN_PASSWORD=${KC_ADMIN_PASSWORD:-$(rand 20)}
  ARCHIVE_AFTER_DAYS=${ARCHIVE_AFTER_DAYS:-14}
  [[ $ARCHIVE_AFTER_DAYS =~ ^[0-9]+$ ]] || die "ARCHIVE_AFTER_DAYS — целое число дней"
  COMPOSE_PROFILES=
  if [[ $SSO == keycloak ]]; then COMPOSE_PROFILES=sso; fi
  if [[ $AI == cpu ]]; then COMPOSE_PROFILES=${COMPOSE_PROFILES:+$COMPOSE_PROFILES,}ai; fi
  # Сертификат прокси нужен и LLM-сервису: он скачивает модель при первом запуске.
  if [[ $AI == cpu && -n ${BUILD_CA_FILE:-} ]]; then LLM_SSL_CERT_FILE=/etc/konsilium/ca.crt; else LLM_SSL_CERT_FILE=; fi

  umask 077
  cat >"$ENV_FILE" <<ENV
# Секреты стенда — не коммитить. Сгенерировано ./stand.sh init $(date -u +%Y-%m-%dT%H:%MZ).
DOMAIN=$DOMAIN
ACME_EMAIL=$ACME_EMAIL
TLS_MODE=$TLS_MODE
NODE_IP=$NODE_IP
# Origin страниц РИС/ЛИС, которым можно встраивать чат (через пробел), например: https://ris.clinic.ru https://lis.clinic.ru
EMBED_ORIGINS="$EMBED_ORIGINS"
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
# Единый вход: keycloak | off. Консоль Keycloak — https://$DOMAIN/auth/admin (admin / KC_ADMIN_PASSWORD).
SSO=$SSO
OIDC_SECRET=$OIDC_SECRET
KC_ADMIN_PASSWORD=$KC_ADMIN_PASSWORD
# ИИ-«Секретарь»: off | cpu. Внешний ИИ-шлюз — LLM_URL и LLM_MODEL (пусто — LLM на стенде).
AI=$AI
COMPOSE_PROFILES=$COMPOSE_PROFILES
SECRETARY_TOKEN=$SECRETARY_TOKEN
LLM_URL=$LLM_URL
LLM_MODEL=$LLM_MODEL
LLM_SSL_CERT_FILE=$LLM_SSL_CERT_FILE
# Архив: через сколько дней без активности закрытый случай уходит в архив (0 — сразу, для проверки).
ARCHIVE_AFTER_DAYS=$ARCHIVE_AFTER_DAYS
ENV

  DOMAIN_RE=${DOMAIN//./\\.}
  EMBED_ORIGINS_JSON=''
  for o in $EMBED_ORIGINS; do EMBED_ORIGINS_JSON+="${EMBED_ORIGINS_JSON:+, }\"$o\""; done
  LIS_TOKEN_SHA=$(sha "$LIS_TOKEN")
  RIS_TOKEN_SHA=$(sha "$RIS_TOKEN")
  TEAM_TOKEN_SHA=$(sha "$TEAM_TOKEN")
  if [[ $AI == cpu ]]; then
    AI_ENV="# ИИ-«Секретарь»: агент и распознавание речи на стенде, токен LiveKit агента — по внутреннему адресу.
SECRETARY_URL=http://secretary:8070
SECRETARY_TOKEN=$SECRETARY_TOKEN
AI_PROFILE=cpu
ASR_URL=ws://vosk:2700
LIVEKIT_INTERNAL_URL=ws://livekit:7880
CCS_CALLBACK_URL=http://ccs:8080
LLM_URL=${LLM_URL:-http://llm:12434/engines/v1}
LLM_MODEL=${LLM_MODEL:-ai/qwen3:1.7b-q4_K_M}"
  else
    AI_ENV='# ИИ-«Секретарь» выключен (AI=off)'
  fi
  if [[ $SSO == keycloak ]]; then
    # Браузер идёт на https://домен/auth, Synapse — напрямую в Keycloak внутри сети стенда (поэтому без проверки https
    # у внутренних адресов; издатель токенов проверяется). sso.client_whitelist — без страницы «Продолжить в …».
    OIDC_YAML="# Единый вход через Keycloak стенда (SSO=keycloak).
oidc_providers:
  - idp_id: keycloak
    idp_name: \"учётную запись организации\"
    issuer: \"https://$DOMAIN/auth/realms/konsilium\"
    discover: false
    skip_verification: true
    authorization_endpoint: \"https://$DOMAIN/auth/realms/konsilium/protocol/openid-connect/auth\"
    token_endpoint: \"http://keycloak:8080/auth/realms/konsilium/protocol/openid-connect/token\"
    userinfo_endpoint: \"http://keycloak:8080/auth/realms/konsilium/protocol/openid-connect/userinfo\"
    jwks_uri: \"http://keycloak:8080/auth/realms/konsilium/protocol/openid-connect/certs\"
    client_id: synapse
    client_secret: \"$OIDC_SECRET\"
    client_auth_method: client_secret_post
    scopes: [\"openid\", \"profile\"]
    allow_existing_users: true
    user_mapping_provider:
      config:
        localpart_template: \"{{ user.preferred_username }}\"
        display_name_template: \"{{ user.family_name }} {{ user.given_name }}\"
sso:
  client_whitelist:
    - \"https://$DOMAIN/\""
  else
    OIDC_YAML='# Единый вход выключен (SSO=off)'
  fi
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
  render realm-konsilium.json realm-konsilium.json
  render ccs.env ccs.env
  render host-mock.env host-mock.env
  umask 022
  render config.json config.json
  if [[ -n $ACME_EMAIL ]]; then echo "email $ACME_EMAIL" >"$GEN/caddy-global.caddy"; else echo "# email для ACME не задан" >"$GEN/caddy-global.caddy"; fi
  # Synapse в контейнере читает конфигурацию от своего пользователя.
  chmod 644 "$GEN"/synapse/* "$GEN"/livekit.yaml "$GEN"/connectors.json "$GEN"/config.json "$GEN"/caddy-global.caddy "$GEN"/realm-konsilium.json
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
  echo "Встраивание в РИС (демо): https://$DOMAIN/sandbox/ris"
  if [[ ${SSO:-off} == keycloak ]]; then echo "Единый вход: кнопка «Войти через учётную запись организации» (Keycloak — https://$DOMAIN/auth)."; fi
  if [[ ${AI:-off} == cpu ]]; then echo "ИИ-«Секретарь» включён: кнопка «Стенограмма» в звонке чата случая."; fi
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

# Учётная запись тестировщика: в Synapse и, если включён единый вход, в Keycloak — с одним паролем.
cmd_add_user() {
  local login=$1 name=${2:-$1} password
  password=$(rand 14)
  compose run --rm --no-deps -e NEW_USER_PASSWORD="$password" host-mock node --import tsx apps/host-mock/src/users.ts add "$login" "$name" >/dev/null
  if [[ ${SSO:-off} == keycloak ]]; then
    local kc=(compose exec -T keycloak /opt/keycloak/bin/kcadm.sh) cfg=(--config /tmp/kcadm.config)
    "${kc[@]}" config credentials --server http://localhost:8080/auth --realm master --user admin --password "$KC_ADMIN_PASSWORD" "${cfg[@]}" >/dev/null 2>&1
    local last=${name%% *} first=${name#* }
    [[ $first == "$name" ]] && first=''
    "${kc[@]}" create users -r konsilium -s "username=$login" -s enabled=true -s emailVerified=true -s "email=$login@stand.invalid" \
      -s "lastName=$last" -s "firstName=$first" "${cfg[@]}" >/dev/null 2>&1 || echo "В Keycloak пользователь $login уже есть — обновляю пароль"
    "${kc[@]}" set-password -r konsilium --username "$login" --new-password "$password" "${cfg[@]}" >/dev/null
  fi
  echo "Пользователь $login создан. Логин: $login, пароль: $password"
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
  add-user) need_init; shift; [[ $# -ge 1 ]] || die 'укажите логин и имя: ./stand.sh add-user ivanov "Иванов И. И."'; cmd_add_user "$@" ;;
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
