# Окружение разработчика

Окружение поднимает три сервиса: PostgreSQL, Synapse 1.162 и LiveKit 1.13 (в режиме `--dev`). PostgreSQL доступен с хоста на порту 55432: там же база `ccs` сервиса контекста (`DATABASE_URL` в `apps/ccs/.env.example`; сервис создаёт её сам). Сервис клинического контекста (`apps/ccs`) и песочница РИС/ЛИС (`apps/host-mock`) запускаются на хосте. Все секреты здесь — только для разработки.

## Запуск

```bash
# из корня репозитория
pnpm install
cd infra && docker compose up -d && cd ..

# сервис контекста (Synapse обращается к нему по адресу host.docker.internal:8080)
cp apps/ccs/.env.example apps/ccs/.env
set -a && . apps/ccs/.env && set +a && pnpm dev:ccs

# в другом терминале — песочница РИС/ЛИС: обратные вызовы на порту 8090, при старте отправит снимки случаев
pnpm dev:host-mock

# пользователи стенда с именами (один раз) и веб-клиент на http://localhost:5173
pnpm dev:users
pnpm dev:web
```

Веб-клиент синхронизируется через Simplified Sliding Sync (Synapse 1.162 поддерживает его без настройки); обычная синхронизация — `?sync=classic` в адресе или `"slidingSync": false` в `config.json`.

Откройте чат случая так же, как его откроет кнопка в ЛИС: <http://localhost:5173/c/lis/Г26-04512>. Встраивание в РИС — демо-страница песочницы <http://localhost:8090/demo/ris> (вход во фрейме как `orlov`). Вход — `smirnova`, пароль `dev-only-password-1`. Цвет бренда можно примерить параметром `?accent=0E7C6B`.

Проверка:
- `curl http://localhost:8008/_matrix/client/versions` — Synapse;
- `curl http://localhost:8080/healthz` — сервис контекста;
- `curl -H 'authorization: Bearer dev-only-lis-token-0123456789abcdef' http://localhost:8080/integration/v1/connector` — подключение ЛИС.

## Тесты

```bash
pnpm test        # модульные тесты всех пакетов
pnpm typecheck   # проверка типов
pnpm test:it     # интеграционные тесты на настоящем Synapse (нужен docker compose up)
pnpm e2e         # сквозные тесты веб-клиента: Playwright сам запускает сервис, песочницу и Vite
```

Интеграционный и сквозной тесты сами поднимают сервис контекста (8080) и песочницу РИС/ЛИС (8090), сквозной — ещё и веб-клиент (5173). Перед запуском остановите `pnpm dev:ccs`, `pnpm dev:host-mock` и `pnpm dev:web`.

Каждый прогон использует свой секрет псевдонимов и свою временную базу PostgreSQL, поэтому данные прошлых прогонов не мешают. Тестовые пользователи создаются через admin API Synapse с общим секретом. Пароль — `dev-only-password-1`.

## Подключения, случаи и пользователи

Подключения — `apps/ccs/fixtures/connectors.json`:

| Подключение | Уровень | Токен подключения | Обратные вызовы |
|---|---|---|---|
| `lis` — ЛИС патоморфологии | 2 | `dev-only-lis-token-0123456789abcdef` | `http://localhost:8090/lis`, токен `dev-only-lis-callback-token-0123456789` |
| `ris` — РИС | 1 | `dev-only-ris-token-0123456789abcdef` | — |

Случаи песочницы — `apps/host-mock/fixtures/cases.json` (данные вымышлены):

| Случай | Участники по ролям | Доступ по требованию |
|---|---|---|
| ЛИС `Г26-04512` | smirnova (патоморфолог), ershova (лаборант ИГХ), kolesnikov (лечащий врач) | gusev (заведующий) — через обратный вызов ЛИС |
| ЛИС `Г26-04530` | smirnova | — (событие не отправляется при старте: сервис запросит снимок у ЛИС) |
| РИС `A26-118734` | orlov (рентгенолог), safonova (рентгенолаборант), melnikova (дежурный терапевт) | belova — по списку `access` в событии |

Пользователь `outsider` доступа ни к одному случаю не имеет.

## API сервиса контекста

**Для клиентов** (токен Matrix пользователя в `Authorization: Bearer`):

- `POST /api/v1/cases/open` с телом `{ "connector": "lis", "caseId": "Г26-04512" }` (или `{ "system": "LIS", … }`, если подключение такого типа одно). Сервис проверяет права, создаёт комнату при первом обращении и приглашает пользователя. Ответ: `{ roomId, alias, created, membership, connector, caseId }`.
- `POST /api/v1/cases/patient` с телом `{ "roomId": "!…" }` — данные пациента у ЛИС для вошедшего участника, без кеширования.
- `POST /api/v1/calls/token` с телом `{ "roomId": "!…" }` — токен LiveKit, только для вошедших участников комнаты.

**Для РИС/ЛИС** (токен подключения) — `/integration/v1/*`, см. [docs/10-integration-api.md](../docs/10-integration-api.md):

- `POST /integration/v1/events` — события CloudEvents (в т.ч. `critical.raised` — критическая находка);
- `GET /integration/v1/critical-findings` — критические находки подключения: время подтверждения, эскалации;
- `GET` и `PUT /integration/v1/cases/{caseId}/chat` — есть ли чат, создать чат;
- `GET /integration/v1/connector` — проверка подключения.

**Для Synapse** — `/_matrix/app/v1/*` (Application Service API). Заявка в чате случая уходит в ЛИС обратным вызовом, статусы `ru.vendor.request.status` возвращаются в чат. Критическая находка (`ru.vendor.critical`) и подтверждение (`ru.vendor.ack`) обрабатываются так же: сервис ведёт статус, срок и эскалацию (план — `critical` в `fixtures/connectors.json`, проверка сроков — каждые `CRITICAL_TICK_MS`, по умолчанию 5 с).

## ИИ-«Секретарь» (профиль `ai`)

Стенограмма звонка и черновик протокола консилиума на процессоре, без GPU и внешних сервисов. Профиль добавляет три контейнера:

| Сервис | Что делает | Порт |
|---|---|---|
| `vosk` | Распознавание русской речи: vosk-server, модель kaldi-ru (Apache-2.0). ~6 ГБ памяти | 2700 (WebSocket) |
| `llm` | LLM для черновика: Docker Model Runner (llama.cpp), модель Qwen3 1.7B (Apache-2.0, ~1,1 ГБ, скачивается один раз в том `models`). ~5 ГБ памяти | 12434 (OpenAI-совместимый API) |
| `secretary` | Агент стенограммы (`apps/secretary`): входит в звонок только на приём, распознаёт дорожку каждого участника | 8070 |

Нужно ~12 ГБ свободной памяти и ~9 ГБ на диске.

```bash
cd infra && docker compose --profile ai up -d && cd ..
# если корпоративный прокси подменяет TLS — сертификат для сборки агента и скачивания модели:
#   BUILD_CA_FILE=/путь/к/ca.crt PROXY_CA_FILE=/путь/к/ca.crt \
#   docker compose -f docker-compose.yml -f docker-compose.proxy-ca.yml --profile ai up -d

# сервис контекста — с настройками «Секретаря» (раскомментируйте блок ИИ в apps/ccs/.env)
set -a && . apps/ccs/.env && set +a && pnpm dev:ccs
```

В звонке чата случая появится кнопка «Стенограмма» (значок документа). Все участники видят индикатор «Стенограмма (ИИ)» и уведомление в чате. После «Остановить» или конца звонка в чат приходят стенограмма (реплики по говорящим) и черновик протокола со ссылками на фрагменты стенограммы; черновик можно принять в протокол или отклонить.

Сквозной тест «Секретаря» (два участника говорят синтезированной речью вместо микрофона):

```bash
E2E_AI=1 pnpm e2e secretary
```

## Остановка и сброс

```bash
cd infra
docker compose down        # остановить
docker compose down -v     # остановить и удалить данные (БД, ключи, медиа)
```
