# Архитектура

Файл описывает, **как код устроен сейчас**. Обновляется по ходу разработки. Что и зачем решено — в `docs/own-backend/BACKEND_PLAN.md`.

## Сейчас (2026-10-23)

Стандартный каркас `nest new`: `AppModule` + `AppController` + `AppService` (hello world), тесты, ESLint, Prettier. Ни БД, ни конфигурации, ни бизнес-кода ещё нет.

Установлено: `@nestjs/common|core|platform-express` 11, `rxjs`, `@nestjs/config` 4, `@nestjs/typeorm` 11, `typeorm`, `pg`, `typeorm-naming-strategies`, `class-validator`, `class-transformer`. Для входа (B1.2, ещё не подключены в коде): `@nestjs/jwt` 11, `@nestjs/throttler` 6, `argon2` 0.45, `google-auth-library` 11. Не установлено (понадобится позже): `ws`, `firebase-admin` и т.д. — см. этапы в `TASKS.md`. Версии `@nestjs/config`, `@nestjs/typeorm` и `@nestjs/jwt` намеренно **не выше 4, 11 и 11** (см. MEMORY).

### Конфигурация (B0.2)

- [src/config/env.validation.ts](src/config/env.validation.ts) — класс `EnvironmentVariables` (правила проверки через `class-validator`) и `validateEnv`. `ConfigModule.forRoot({ isGlobal: true, validate: validateEnv })` в `AppModule`: при неверных переменных сервер не стартует и пишет, какая именно не подошла.
- Переменные: `NODE_ENV` (по умолчанию `development`), `PORT` (3000), `DATABASE_URL` (обязательна, `postgres://`/`postgresql://`), `SELF_PING_URL` (необязательна, `http(s)://…`), `JWT_SECRET` (обязательна, ≥ 32 символов — подпись токенов входа), `GOOGLE_CLIENT_IDS` (необязательна; список через запятую превращается в массив строк; не задана — вход через Google отклоняет любые токены). Образец — `.env.example`; настоящий `.env` в git не попадает.
- Новую переменную добавлять в `EnvironmentVariables` и в `.env.example`.

### База данных (B0.3)

- [src/database/data-source-options.ts](src/database/data-source-options.ts) — `buildDataSourceOptions(url)`: единые настройки подключения (пул 5, закрытие простаивающих через 10 с, таймаут подключения 30 с, `synchronize: false`, snake_case). Её же возьмёт CLI миграций (B0.4), чтобы приложение и миграции подключались одинаково.
- [src/database/database.module.ts](src/database/database.module.ts) — `TypeOrmModule.forRootAsync`, берёт `DATABASE_URL` из конфигурации; `autoLoadEntities: true` (каждый модуль сам регистрирует свои сущности через `forFeature`); при старте 2 попытки подключения с паузой 3 с.
- SSL включается не в коде, а параметром `?sslmode=require` в `DATABASE_URL` (в production без него сервер не стартует).

### Миграции (B0.4)

- Схему меняют **только** миграции в [src/migrations/](src/migrations/) (имя `<время>-<Название>.ts`).
- [src/database/data-source.ts](src/database/data-source.ts) — вход для командной строки TypeORM; берёт `DATABASE_URL` из окружения или из `.env`, проверяет его тем же `validateEnv`. Работает из `dist/`, поэтому перед запуском нужна сборка.
- Команды: `npm run migration:run` (применить), `migration:revert` (откатить последнюю), `migration:show` (что применено), `migration:create -- src/migrations/Имя` (пустая миграция), `migration:generate -- src/migrations/Имя` (TypeORM сам сравнит сущности с базой; сначала сам делает `nest build`).
- Приложение миграции само **не запускает**: на деплое их надо запускать отдельным шагом перед стартом (решим в B0.8).
- Первая миграция: функция `set_updated_at()` — триггер на таблицах ставит `updated_at = clock_timestamp()`. Каждая синхронизируемая таблица подключает её так: `create trigger <table>_updated_at before insert or update on <table> for each row execute function set_updated_at();`

### Health (B0.5)

- [src/health/health.controller.ts](src/health/health.controller.ts): `GET /health` → `{ok:true}`, **в базу не ходит** (его будет пинговать сам сервер); `GET /health/db` → `select 1`, при ошибке `503 {code:"db_unavailable", message}` (текст ошибки базы клиенту не отдаётся, только в лог).
- Шаблонные `AppController`/`AppService` («Hello World») удалены.

### Формат ошибок (B0.6)

- [src/common/all-exceptions.filter.ts](src/common/all-exceptions.filter.ts) — глобальный фильтр (`APP_FILTER` в `AppModule`). Любая ошибка уходит клиенту как `{ "code": "...", "message": "..." }`, больше никаких полей.
- Свой код выбирается так: `throw new ConflictException({ code: 'email_taken', message: '...' })`. Без кода берётся стандартный по статусу (`not_found`, `forbidden`, `too_many_requests`, …). Список сообщений от `ValidationPipe` склеивается в одну строку с кодом `validation_failed`.
- Неожиданная ошибка (не `HttpException`) → `500 internal_error`, текст скрыт, стек пишется в лог.
- Сам `ValidationPipe` ещё не подключён — это сделаем в B1 вместе с первыми DTO (описаниями тел запросов).

### Самопинг и остановка (B0.7)

- [src/health/self-ping.service.ts](src/health/self-ping.service.ts): если задан `SELF_PING_URL`, раз в 5 минут делает `GET <SELF_PING_URL>/health` (таймаут 30 с). Ошибка пинга только пишется в лог. Таймер не удерживает процесс (`unref`) и останавливается при выключении. Без `SELF_PING_URL` ничего не делает.
- [src/main.ts](src/main.ts): `app.enableShutdownHooks()` — по сигналу остановки (при деплое Render шлёт SIGTERM) приложение закрывает пул БД и таймеры.

### Docker (B0.8)

- [Dockerfile](Dockerfile): два этапа. Первый (`node:22-slim`) ставит все зависимости и собирает `dist/`; второй берёт только рабочие зависимости (`npm ci --omit=dev`) и готовый `dist/`. Образ ≈ 313 МБ, работает от пользователя `node`, `NODE_ENV=production`.
- Запуск: `npm run migration:run && exec node dist/main` — сначала применяются новые миграции, потом стартует сервер (`exec`, чтобы сигнал остановки дошёл до node).
- [.dockerignore](.dockerignore): не пускает в образ `node_modules`, `.env`, `docs`, `.git`, тесты и т.п.
- Переменные окружения те же, что в `.env.example`; Render подставляет `PORT` сам. В production `DATABASE_URL` обязана содержать `sslmode`.
- Локальная проверка образа: `docker build -t nook-back .`, затем `docker run -p 3000:3000 -e DATABASE_URL=… nook-back`. Для базы без TLS (локальный Postgres) добавить `-e NODE_ENV=development`.

### Тесты с настоящей базой (B1.1)

- Тестовая база: Postgres 17 в Docker ([docker-compose.test.yml](docker-compose.test.yml), порт 54330, данные в памяти и пропадают при остановке). Запуск: `npm run test:db:up`, остановка: `npm run test:db:down`. Нужен запущенный Docker.
- `npm run test:e2e` перед тестами ([test/global-setup.ts](test/global-setup.ts)) применяет все миграции к тестовой базе; тесты идут по одному процессу (`maxWorkers: 1`), потому что база общая.
- Помощники в [test/support/](test/support/): `createTestApp()` — настоящий `AppModule` на тестовой базе; `truncateAll(ds)` — очистить все таблицы, кроме `migrations` (вызывать в `beforeEach`).
- **Защита от Neon (два слоя):** (1) [test/support/env.ts](test/support/env.ts) выполняется jest-ом до любых импортов и подставляет `DATABASE_URL` тестовой базы — иначе `ConfigModule` при импорте прочитал бы боевой `.env`; (2) `createTestApp()` проверяет, к какой базе приложение реально подключилось, и отказывается работать, если хост не локальный. Тот же запрет в `global-setup.ts`.
- Адрес тестовой базы можно сменить переменной `TEST_DATABASE_URL`, но только на локальный хост.
- Правило линтера «небезопасный any» для `test/` смягчено: результаты сырого SQL не типизированы.

## Куда движемся

Схема из плана (раздел 7–8); имена модулей — предложение, уточним на старте каждого этапа.

```
Приложение (Flutter, offline-first)
   │  HTTPS: /auth, /sync/pull, /sync/push, /groups, /devices, /me
   │  WSS:   /ws  (сервер шлёт только «changed», данных нет)
   ▼
NestJS (Render free) ──► PostgreSQL (Neon free)
   │
   └─► Firebase Cloud Messaging (push)
```

| Модуль (план) | Этап | Что делает |
|---|---|---|
| `config`, `database` | B0 | переменные окружения, подключение к Neon, миграции |
| `health` | B0 | `/health` (без БД), `/health/db` |
| `auth`, `users` | B1 | регистрация, вход, Google, JWT + refresh |
| `sync` | B2–B4 | `pull` / `push` для задач, дневника, цикла |
| `groups` | B5 | группы, участники, коды приглашения, права |
| `realtime` | B6 | WebSocket-шлюз `/ws` |
| `push` | B7 | устройства, отправка через FCM |

## Решения, которые определяют форму кода

- Сервер подстраивается под приложение: ключи строк = ключи из `reference/payload.dart.txt`.
- Конфликты решает клиент при pull; сервер — «последний пришедший запрос побеждает».
- Права (бывший RLS Supabase) — проверки в коде; на каждое правило тест.
- Два штампа: `updated_at` (сервер, триггер) и `client_updated_at` (устройство).
