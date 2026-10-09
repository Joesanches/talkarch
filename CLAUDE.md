# «Консилиум» — заметки для Claude Code

Медицинский мессенджер на Matrix: чаты случаев из РИС/ЛИС, критические находки, консилиумы, звонки (LiveKit), ИИ-«Секретарь», push в контуре. Что и почему — в `README.md` и `docs/` (архитектура — `docs/03`, план и находки по шагам — `docs/09`, нагрузка и Tuwunel — `docs/11`).

## Устройство

- `apps/ccs` — сервис клинического контекста (Matrix Application Service, Fastify, PostgreSQL); контракты — `apps/ccs/openapi`.
- `apps/web` — веб-клиент (React, matrix-js-sdk, Simplified Sliding Sync) и SDK встраивания; сквозные тесты — `apps/web/e2e`.
- `apps/push-gateway` — push-шлюз в контуре (Matrix Push Gateway API, прямое соединение, APNs/FCM/RuStore).
- `apps/host-mock` — песочница РИС/ЛИС/МИС; `apps/secretary` — ИИ-агент стенограммы.
- `packages/protocol` — типы и схемы событий (zod), общие для всех; `packages/embed`, `packages/tokens`.
- `infra/` — окружение разработчика (Synapse или Tuwunel, PostgreSQL, Keycloak, LiveKit); `deploy/stand/` — стенд одной командой (`stand.sh`); `tools/load` — нагрузочный тест.

## Команды

```bash
pnpm install
cd infra && docker compose up -d && cd ..          # Synapse; Tuwunel — infra/README.md
pnpm typecheck && pnpm test                         # проверка типов и модульные тесты
pnpm test:it                                        # интеграционные: сервис контекста и push-шлюз на настоящем сервере
pnpm e2e                                            # сквозные тесты веб-клиента (Playwright сам поднимает сервисы)
```

Порты разработки: Synapse/Tuwunel 8008, сервис контекста 8080, песочница 8090, push-шлюз 8075, веб 5173, Keycloak 8180.

## Правила проекта

- Документация, комментарии, сообщения коммитов и интерфейс — по-русски, в стиле существующих `docs/`.
- Только вымышленные данные: никаких персональных данных в коде, тестах, фикстурах и журналах.
- Секреты разработки помечены `dev-only`. Настоящие секреты не коммитить (`deploy/stand/.env` и `deploy/stand/generated/` — в `.gitignore`).
- В ядро — без зависимостей под AGPL, GPL и MPL (поэтому Valkey вместо Redis, свой клиент Matrix в сервисе контекста). Лицензию новой зависимости проверять до добавления.
- Push и уведомления — без содержимого: только идентификаторы и вид события (`docs/03`, раздел 6).
- Продукт не зависит от сервера сообщений: изменения синхронизации, приглашений и push проверять на Synapse и на Tuwunel (переключение — `infra/README.md`). Известные расхождения Tuwunel и их обходы — `docs/11`, раздел 7.4.
- Проверку TLS не отключать; за корпоративным прокси — его корневой сертификат (`BUILD_CA_FILE` для стенда, `NODE_EXTRA_CA_CERTS` для Node).
- После законченного блока: проверка типов, тесты, обновлённые `docs/`, коммит.
