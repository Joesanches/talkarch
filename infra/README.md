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

**Единый вход.** Окружение поднимает Keycloak (<http://localhost:8180>, realm `konsilium`): на странице входа есть кнопка «Войти через учётную запись организации», логины и пароль — те же, что у демо-пользователей. Консоль администратора — <http://localhost:8180/admin> (`admin` / `dev-only-keycloak-admin`). Вход по паролю на странице «Консилиума» остаётся для тестов.

Откройте чат случая так же, как его откроет кнопка в ЛИС: <http://localhost:5173/c/lis/Г26-04512>. Встраивание в РИС — демо-страница песочницы <http://localhost:8090/demo/ris> (вход во фрейме как `orlov`), в ЛИС — <http://localhost:8090/demo/lis> (плавающий чат, вход как `smirnova`). Вход — `smirnova`, пароль `dev-only-password-1`. Цвет бренда можно примерить параметром `?accent=0E7C6B`.

**Консилиум.** Песочница при старте назначает «Онкоконсилиум» на сегодня из трёх случаев ЛИС и РИС: войдите как `belova` (председатель) или `petrov` (секретарь), он — в папке «Каналы». Стенограмма без профиля `ai` — демо-агент песочницы (сценарий реплик вместо распознавания): в `apps/ccs/.env` задайте `SECRETARY_URL=http://localhost:8090/demo/secretary`, `SECRETARY_TOKEN=dev-only-secretary-token-0123456789`, `AI_PROFILE=external`. Сквозной тест `pnpm e2e consilium` включает его сам.

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

- `POST /api/v1/cases/open` с телом `{ "connector": "lis", "caseId": "Г26-04512" }` (или `{ "system": "LIS", … }`, если подключение такого типа одно). Сервис проверяет права, создаёт комнату при первом обращении и приглашает пользователя. Ответ: `{ roomId, alias, created, membership, connector, caseId, archived }`. Архивный чат — возврат только для чтения (`archived: true`).
- `GET /api/v1/archive?q=…` — папка «Архив»: закрытые случаи, в чатах которых пользователь участвовал.
- `POST /api/v1/cases/patient` с телом `{ "roomId": "!…" }` — данные пациента у ЛИС для вошедшего участника, без кеширования.
- `POST /api/v1/calls/token` с телом `{ "roomId": "!…" }` — токен LiveKit, только для вошедших участников комнаты.

**Для РИС/ЛИС** (токен подключения) — `/integration/v1/*`, см. [docs/10-integration-api.md](../docs/10-integration-api.md):

- `POST /integration/v1/events` — события CloudEvents (в т.ч. `critical.raised` — критическая находка);
- `GET /integration/v1/critical-findings` — критические находки подключения: время подтверждения, эскалации;
- `GET` и `PUT /integration/v1/cases/{caseId}/chat` — есть ли чат, создать чат;
- `GET /integration/v1/connector` — проверка подключения.

**Для Synapse** — `/_matrix/app/v1/*` (Application Service API). Заявка в чате случая уходит в ЛИС обратным вызовом, статусы `ru.vendor.request.status` возвращаются в чат. Критическая находка (`ru.vendor.critical`) и подтверждение (`ru.vendor.ack`) обрабатываются так же: сервис ведёт статус, срок и эскалацию (план — `critical` в `fixtures/connectors.json`, проверка сроков — каждые `CRITICAL_TICK_MS`, по умолчанию 5 с).

**Архив чатов случаев.** Случай закрыт или отменён в РИС/ЛИС, а в чате `ARCHIVE_AFTER_DAYS` дней (по умолчанию 14) нет активности — чат уходит в архив: только чтение, участники выведены, история сохранена. Пока в чате есть неподтверждённая критическая находка, он в архив не уходит. Вернуться можно из папки «Архив» или по ссылке на случай; через `ARCHIVE_RETURN_HOURS` (24) вернувшийся снова выводится. Случай снова открыт в системе-источнике — чат возвращается из архива. Проверка — каждые `ARCHIVE_TICK_MS` (5 мин).

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

## Synapse с воркерами

Схема продуктивного сервера ([docs/03-architecture.md, 9.2](../docs/03-architecture.md#92-сервер)) в миниатюре — для проверки и нагрузочного теста:

```bash
cd infra
docker compose -f docker-compose.yml -f docker-compose.workers.yml up -d    # с воркерами
docker compose up -d --remove-orphans                                       # обратно — один процесс
```

| Процесс | Что делает |
|---|---|
| `synapse` | Главный процесс: API клиентов (отправка, комнаты, вход), Application Service сервиса контекста |
| `synapse-sync1`, `synapse-sync2` | Синхронизация: `/sync` и Simplified Sliding Sync. Пользователь всегда попадает на один и тот же воркер (там его кеш) |
| `synapse-persister1`, `synapse-persister2` | Запись событий в базу: комнаты распределены между ними по хешу ID |
| `valkey` | Обмен между процессами Synapse. Valkey — совместимая с Redis замена под BSD-3: у Redis 7.4+ лицензии RSAL/SSPL, у Redis 8 — ещё и AGPLv3 |
| `synapse-router` | Caddy на порту 8008 вместо главного процесса: синхронизацию — воркерам, остальное — главному процессу |

Конфигурация — `synapse/workers/`. Клиенты, сервис контекста и тесты работают с тем же адресом `http://localhost:8008`. Учтите задержку репликации: изменение, сделанное через главный процесс (например, «забыть» комнату), воркер синхронизации видит через доли секунды.

## Tuwunel вместо Synapse

Для сравнения серверов ([docs/11-load-test.md, раздел 7](../docs/11-load-test.md#7-tuwunel-против-synapse-прогоны-7-и-8)) окружение поднимается на [Tuwunel](https://github.com/matrix-construct/tuwunel) (Rust, Apache-2.0) — тот же порт 8008, та же регистрация сервиса контекста и тот же Keycloak:

```bash
cd infra
docker compose stop synapse
docker compose -f docker-compose.yml -f docker-compose.tuwunel.yml up -d    # Tuwunel
docker compose -f docker-compose.yml -f docker-compose.tuwunel.yml stop tuwunel && docker compose up -d   # обратно на Synapse
```

Конфигурация — `tuwunel/tuwunel.toml`. Отличия для разработчика:

- admin API Synapse нет: `pnpm dev:users` и тесты регистрируют пользователей по токену регистрации (тот же dev-only-секрет);
- база — встроенная RocksDB в томе `tuwunel-data`, PostgreSQL нужен только сервису контекста;
- администрирование — командами в комнате администраторов (первый зарегистрированный пользователь становится администратором сервера);
- расхождения Simplified Sliding Sync и приглашений Tuwunel продукт обходит сам — сквозные тесты проходят на обоих серверах ([docs/11-load-test.md, 7.4](../docs/11-load-test.md#74-совместимость)).

## Остановка и сброс

```bash
cd infra
docker compose down        # остановить
docker compose down -v     # остановить и удалить данные (БД, ключи, медиа)
```
