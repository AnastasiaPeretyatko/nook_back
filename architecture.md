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
- Проверка входных данных — [src/common/validation.pipe.ts](src/common/validation.pipe.ts), подключена глобально (`APP_PIPE` в `AppModule`): `transform` (тела становятся DTO-классами, числа из адреса — числами), `whitelist` (поля без правила **молча отбрасываются**, не отклоняются), одно сообщение на поле.
- Код ошибки правилу задаёт `withCode`: `@IsEmail({}, withCode('invalid_email', 'Invalid email'))`. Ответ — `400 {code, message}`; кодом становится код первого упавшего поля (в порядке полей DTO), без кода — `validation_failed`; сообщения всех упавших полей склеены через `; `. Правила пишем только в DTO-классах, не в сервисах.

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

### Таблицы входа (B1.4)

Миграция [CreateAuthTables](src/migrations/1792767790080-CreateAuthTables.ts); классы в коде только описывают таблицы (сами ограничения и триггер — в SQL миграции).

| Таблица | Сущность | Главное |
|---|---|---|
| `users` | [User](src/users/user.entity.ts) | `id` (uuid, создаёт база), `email` (уникален, **только нижний регистр** — проверяет база), `password_hash` и `google_sub` (оба могут быть пустыми, но не одновременно; `google_sub` уникален), `created_at` |
| `refresh_tokens` | [RefreshToken](src/auth/refresh-token.entity.ts) | PK — `token_hash` (SHA-256, сам токен не хранится), `user_id` (удаляется вместе с пользователем), `expires_at`. **Одноразовый:** при обновлении строка удаляется и вставляется следующая; повторное использование = строки нет = отказ |
| `profiles` | [Profile](src/users/profile.entity.ts) | PK `user_id` (удаляется вместе с пользователем), `display_name` ≤ 100, `avatar_url` ≤ 2048, `updated_at` (триггер `set_updated_at`, приложение его не пишет). Строка появляется, когда нужна |

- Модули: [UsersModule](src/users/users.module.ts) (User, Profile) и [AuthModule](src/auth/auth.module.ts) (RefreshToken) пока только регистрируют сущности; логика — в следующих задачах B1.
- Параметры подключения: `uuidExtension: 'pgcrypto'` (чтобы TypeORM понимал `gen_random_uuid()`) и `installExtensions: false` (расширения не ставим — функция встроена в Postgres).
- Тест [test/schema.e2e-spec.ts](test/schema.e2e-spec.ts) сверяет сущности с настоящей схемой (`createSchemaBuilder().log()` должен ничего не предлагать менять) и проверяет каждое ограничение. **Меняешь сущность — меняй и миграцию, иначе этот тест упадёт.** Ограничения и внешние ключи в сущностях названы так же, как в SQL — это нужно для сверки.

### Пароли и токены (B1.6)

Живут в [AuthModule](src/auth/auth.module.ts), наружу экспортируются `PasswordService` и `TokenService`. Маршрутов пока нет — их строит B1.7.

- [PasswordService](src/auth/password.service.ts): `hash(password)` — argon2id (19 МиБ, 2 прохода, 1 поток); `verify(hash, password)` — `true/false`. Если хеша нет (почта не найдена, аккаунт только из Google), всё равно выполняется полная проверка argon2 против заготовленного хеша и ответ всегда `false`: по времени ответа нельзя узнать, есть ли такая почта. Битый хеш в базе = «не подошёл», не ошибка сервера.
- [TokenService](src/auth/token.service.ts), access-токен: `signAccessToken(userId)` — JWT (HS256, в нём только `sub`, живёт 1 час, секрет `JWT_SECRET`); `verifyAccessToken(token)` — id пользователя или `null` (плохая подпись, просрочен, чужой алгоритм, `sub` не строка). **В базу не ходит.**
- Refresh-токен: `issueRefreshToken(userId, manager?)` — случайные 32 байта (base64url), в базе только SHA-256; срок 90 дней по часам базы; заодно удаляет **просроченные токены этого же пользователя** (таймеров нельзя). `rotateRefreshToken(token)` — в одной транзакции удаляет строку (`DELETE … RETURNING`, условие «не просрочен») и выпускает следующий токен; кто удалил строку, тот и выиграл — из пяти одновременных запросов успешен ровно один; нет строки → `401 invalid_refresh_token`; если выпуск нового упал, старый остаётся рабочим. `revokeRefreshToken(token)` — выход; лишние и неизвестные токены не ошибка.
- Тесты: юнит — [password.service.spec.ts](src/auth/password.service.spec.ts), [token.service.spec.ts](src/auth/token.service.spec.ts); на настоящей базе — [test/refresh-tokens.e2e-spec.ts](test/refresh-tokens.e2e-spec.ts).

### Маршруты входа (B1.7)

[AuthController](src/auth/auth.controller.ts) → [AuthService](src/auth/auth.service.ts). Тела описаны в [src/auth/dto/](src/auth/dto/). Контроллер помечен `@Public()` (см. «Защита маршрутов» ниже).

| Маршрут | Тело | Успех | Ошибки |
|---|---|---|---|
| `POST /auth/register` | `{email, password}` | `201 {accessToken, refreshToken, user}` | `400 invalid_email`, `400 weak_password` (8–128 символов), `409 email_taken` |
| `POST /auth/login` | `{email, password}` | `200 {accessToken, refreshToken, user}` | `401 invalid_credentials` (неверный пароль, неизвестная почта и аккаунт только из Google — один и тот же ответ), `400 validation_failed` для кривого тела |
| `POST /auth/google` | `{idToken}` | `200 {accessToken, refreshToken, user}` (и для нового, и для вернувшегося) | `401 google_token_invalid` (не подтверждён Google, чужой клиент, просрочен, почта Google не подтверждена, вход через Google не настроен), `409 google_email_conflict`, `400 validation_failed` |
| `POST /auth/refresh` | `{refreshToken}` | `200 {accessToken, refreshToken}` (без `user`) | `401 invalid_refresh_token` |
| `POST /auth/logout` | `{refreshToken}` | `204` без тела (повтор и чужой токен — тоже `204`) | — |

- `user` = `{id, email, displayName, avatarUrl}`; имя и аватар — `null`, пока не заданы. Читает их [UsersService](src/users/users.service.ts) одним запросом с `left join profiles`.
- Почта обрезается по краям и приводится к нижнему регистру в DTO. Регистрация полагается на уникальный индекс `users_email_key` (а не на предварительную проверку), поэтому два одновременных запроса с одной почтой дают ровно один `201` и один `409`. Вход не проверяет «красоту» почты и пароля — любая неудача это `invalid_credentials`.
- Каждый вход открывает **новую** сессию (новый refresh-токен), старые не трогает; выход закрывает только ту сессию, чей токен прислан.
- Тесты: [test/auth.e2e-spec.ts](test/auth.e2e-spec.ts) (20 штук, настоящий `AppModule` и база).

### Защита маршрутов (B1.8)

- [AuthGuard](src/auth/auth.guard.ts) подключён **глобально** (`APP_GUARD` в `AppModule`): **закрыто всё, что не помечено** [`@Public()`](src/auth/public.decorator.ts). Открыты только `AuthController` и `HealthController` целиком. Новый контроллер по умолчанию требует токен.
- Токен берётся из `Authorization: Bearer <accessToken>` (слово `Bearer` в любом регистре, ровно один токен). Любая неудача — пустой заголовок, чужая схема, битая подпись, просрочка, refresh-токен вместо access — даёт один и тот же ответ `401 {code:"unauthorized"}`; приложение по нему обновляет токен или просит войти.
- В обработчике id пользователя берётся так: `@CurrentUserId() userId: string` ([auth.guard.ts](src/auth/auth.guard.ts)). Он всегда из проверенного токена; тело, адрес и заголовки клиента на него не влияют. **Нигде больше `user_id` не брать.**
- Проверка токена — по подписи, **без обращения к базе** (так Neon не просыпается на каждый запрос). Следствие: токен удалённого аккаунта работает до часа. Это зафиксировано отдельным тестом, чтобы изменить его можно было только осознанно.
- Несуществующий маршрут отвечает `404` (охранник до него не доходит).
- Тесты: [auth.guard.spec.ts](src/auth/auth.guard.spec.ts) (разбор заголовка), [test/access-guard.e2e-spec.ts](test/access-guard.e2e-spec.ts) (настоящее приложение + тестовый контроллер `ProbeController`, который добавляется через `createTestApp([ProbeController])`). Там же тест-«сторож»: список публичных контроллеров зашит в тест; сделать ещё что-то открытым можно, только поменяв этот список.

### Профиль: `/me` (B1.9)

[MeController](src/users/me.controller.ts) в `UsersModule`; оба маршрута требуют токен, id берётся из него.

| Маршрут | Тело | Ответ |
|---|---|---|
| `GET /me` | — | `200 {id, email, displayName, avatarUrl}` (имя и аватар `null`, пока не заданы; ничего не создаёт) |
| `PUT /me/profile` | `{displayName, avatarUrl}` | `200` тот же `user` |

- **Оба поля обязательны** (`PUT` заменяет профиль целиком); `null` очищает поле. Пустая или из одних пробелов строка тоже превращается в `null`; имя обрезается по краям.
- Имя — до 100 символов. Аватар — только адрес `https://…` до 2048 символов (его загружают телефоны других участников; `http:`, `javascript:`, `file:` отклоняются). Неверное → `400 validation_failed`, профиль не меняется.
- Строка `profiles` создаётся при первом сохранении одним запросом (`upsert` по `user_id`); `updated_at` обновляет триггер при каждом сохранении.
- Токен есть, а аккаунта уже нет → `401 unauthorized` (и `GET`, и `PUT`; в `PUT` ничего не создаётся).
- В [UsersService](src/users/users.service.ts): `getById(id)` (бросает 401, если аккаунта нет), `updateProfile(userId, …)`, `findByEmail` (для входа; с хешем пароля, наружу не отдаётся).
- Тесты: [test/me.e2e-spec.ts](test/me.e2e-spec.ts) (25 штук).

### Ограничение частоты запросов (B1.10)

`ThrottlerModule` + `ThrottlerGuard` в [AppModule](src/app.module.ts), **стоит перед** `AuthGuard`: запрос считается до проверки токена, поэтому перебор без токена тоже ограничен (иначе его бы остановил `401` до подсчёта).

| Где | В минуту | В час | Счётчик |
|---|---|---|---|
| все маршруты по умолчанию | 120 | 3000 | на адрес клиента и на маршрут |
| `/auth/*` (регистрация, вход, обновление, выход) | 10 | 60 | на адрес клиента и на **каждый маршрут отдельно** |
| `/health*` | без лимита (`@SkipThrottle({burst, sustained})`) | | |

- Превышение → `429 {code:"too_many_requests", message}` и заголовки `Retry-After-burst` / `Retry-After-sustained` (секунды). Имя в заголовке — потому что лимитеры именованные (`burst`, `sustained`).
- **Счётчики хранятся в памяти сервера**: при перезапуске Render обнуляются, между серверами не делятся. Для одного маленького сервера допустимо; лимиты, которые должны переживать перезапуск (неверные коды групп, B5), хранятся в базе.
- **Адрес клиента за прокси.** [`configureProxy`](src/app.setup.ts) (вызывается в [main.ts](src/main.ts) и в тестах) включает `trust proxy` на `TRUST_PROXY_HOPS` прыжков. 0 (по умолчанию) — заголовок `X-Forwarded-For` игнорируется, адрес берётся из соединения. Слишком много — клиент может подделать адрес и получать новый счётчик; слишком мало — все пользователи Render делят один счётчик и блокируют друг друга. **На Render правильное значение — 3** (клиент → Cloudflare → внутренний балансировщик → локальный сокет; измерено, см. MEMORY). Типичное «1» там неверно.
- `RATE_LIMIT=off` выключает лимитер — **только для тестов** (в `test/support/env.ts`); в production сервер с `off` не стартует. Тест лимитера включает его сам.
- Тесты: [test/rate-limit.e2e-spec.ts](test/rate-limit.e2e-spec.ts) (10 штук: порог и `429`, раздельные маршруты, часовой лимит через подмену времени, общий лимит 120, порядок «лимит → токен», `/health`, три сценария с прокси).

### Вход через Google (B1.11)

- [GoogleTokenVerifier](src/auth/google-token.verifier.ts) проверяет ID-токен: подпись по открытым ключам Google (библиотека сама их скачивает и кэширует), издателя, срок и **адресата** — токен должен быть выписан для одного из наших клиентов из `GOOGLE_CLIENT_IDS`. Если список пуст — не принимается ничего (библиотека без адресата проверку `aud` молча пропускает, поэтому это отдельное правило с тестом). Токен и почта в лог не пишутся (библиотека кладёт токен в текст ошибок).
- [AuthService.loginWithGoogle](src/auth/auth.service.ts): аккаунт ищется по Google-идентификатору `sub`, **не по почте**. Нашёлся — вход (профиль и почту не перезаписываем). Не нашёлся — создаётся пользователь без пароля + профиль из Google (имя до 100 символов, фото только `https` до 2048) + сессия.
- **Почта уже занята другим аккаунтом (парольным или чужим Google) → `409 google_email_conflict`, ничего не меняется.** Автослияния нет: почту при регистрации мы не подтверждаем, и иначе тот, кто зарегистрировал чужой адрес первым, получил бы доступ владельцу Google. Цена: человек с таким «занятым» адресом не сможет войти через Google, пока не появится слияние с запросом пароля (открытый вопрос плана).
- Почта Google не подтверждена (`email_verified` не `true`) → `google_token_invalid`.
- Две одновременные первые попытки одного Google-аккаунта: проигравшая находит победителя и входит в тот же аккаунт (тест принудительно создаёт такую гонку).
- Для тестов проверка подменяется через `createTestApp([], 0, (b) => b.overrideProvider(GoogleTokenVerifier).useValue(fake))`. Сама проверка покрыта юнит-тестами с настоящими RS256-токенами, подписанными своим ключом ([google-token.verifier.spec.ts](src/auth/google-token.verifier.spec.ts)).

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
