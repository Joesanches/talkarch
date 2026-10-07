# Окружение разработчика

Окружение поднимает три сервиса: PostgreSQL, Synapse 1.162 и LiveKit 1.13 (в режиме `--dev`). Сервис клинического контекста (`apps/ccs`) запускается на хосте. Все секреты здесь — только для разработки.

## Запуск

```bash
# из корня репозитория
pnpm install
cd infra && docker compose up -d && cd ..

# сервис контекста (Synapse обращается к нему по адресу host.docker.internal:8080)
cp apps/ccs/.env.example apps/ccs/.env
set -a && . apps/ccs/.env && set +a && pnpm dev:ccs
```

Проверка:
- `curl http://localhost:8008/_matrix/client/versions` — Synapse;
- `curl http://localhost:8080/healthz` — сервис контекста.

## Тесты

```bash
pnpm test        # модульные тесты всех пакетов
pnpm typecheck   # проверка типов
pnpm test:it     # интеграционные тесты на настоящем Synapse (нужен docker compose up)
```

Интеграционный тест сам поднимает сервис контекста на порту 8080. Перед `pnpm test:it` остановите `pnpm dev:ccs`.

Каждый прогон использует свою «организацию», поэтому комнаты из прошлых прогонов не мешают. Тестовые пользователи создаются через admin API Synapse с общим секретом. Пароль — `dev-only-password-1`.

## Тестовые пользователи и случаи

Справочник случаев — `apps/ccs/fixtures/host-directory.json`:

| Случай | Участники по ролям | Доступ по требованию |
|---|---|---|
| ЛИС `Г26-04512` | smirnova (патоморфолог), ershova (лаборант ИГХ), kolesnikov (лечащий врач) | gusev (заведующий) |
| РИС `A26-118734` | orlov (рентгенолог), safonova (рентгенолаборант), melnikova (дежурный терапевт) | — |

Пользователь `outsider` доступа ни к одному случаю не имеет.

## API сервиса контекста

- `POST /api/v1/cases/open` с телом `{ "system": "LIS", "caseId": "Г26-04512" }` и токеном Matrix в заголовке `Authorization: Bearer`.
  - Сервис проверяет права в системе-источнике, создаёт комнату при первом обращении и приглашает пользователя.
  - Ответ: `{ roomId, alias, created, membership }`.
- `POST /api/v1/calls/token` с телом `{ "roomId": "!…" }` — токен LiveKit, только для вошедших участников комнаты.
- `/_matrix/app/v1/*` — API Application Service для Synapse. Заявка в чате случая уходит в ЛИС (заглушку), и статус `ru.vendor.request.status` возвращается в чат.

## Остановка и сброс

```bash
cd infra
docker compose down        # остановить
docker compose down -v     # остановить и удалить данные (БД, ключи, медиа)
```
