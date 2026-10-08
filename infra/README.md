# Окружение разработчика

Окружение поднимает три сервиса: PostgreSQL, Synapse 1.162 и LiveKit 1.13 (в режиме `--dev`). Сервис клинического контекста (`apps/ccs`) и песочница РИС/ЛИС (`apps/host-mock`) запускаются на хосте. Все секреты здесь — только для разработки.

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

Каждый прогон использует свой секрет псевдонимов, поэтому комнаты из прошлых прогонов не мешают. Тестовые пользователи создаются через admin API Synapse с общим секретом. Пароль — `dev-only-password-1`.

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

- `POST /integration/v1/events` — события CloudEvents;
- `GET` и `PUT /integration/v1/cases/{caseId}/chat` — есть ли чат, создать чат;
- `GET /integration/v1/connector` — проверка подключения.

**Для Synapse** — `/_matrix/app/v1/*` (Application Service API). Заявка в чате случая уходит в ЛИС обратным вызовом, статусы `ru.vendor.request.status` возвращаются в чат.

## Остановка и сброс

```bash
cd infra
docker compose down        # остановить
docker compose down -v     # остановить и удалить данные (БД, ключи, медиа)
```
