# Архитектура

Файл описывает, **как код устроен сейчас**. Обновляется по ходу разработки. Что и зачем решено — в `docs/own-backend/BACKEND_PLAN.md`.

## Сейчас (2026-10-29, после B6; B6.6 ждёт деплоя)

Работает: конфигурация и подключение к Neon, миграции, `/health`, единый формат ошибок, вход (почта и пароль, Google, `/me`) — этап B1; личные задачи и отметки дня с маршрутами `GET /sync/pull` и `POST /sync/push` — этап B2; дневник (заметки, метки, настроения, связи, стартовые настроения) в тех же маршрутах — этап B3; цикл — B4; группы — B5; WebSocket `/ws` со звонком `changed` — B6 (разделы «WebSocket…» ниже). Модули: `config`, `database`, `health`, `auth`, `users`, `tasks`, `diary`, `cycle`, `groups` (таблицы и маршруты), `sync` (маршруты и запись), `realtime` (реестр подключений и звонарь) и `realtime-gateway` (шлюз `/ws`). Дальше — B7 (push).

Установлено: `@nestjs/common|core|platform-express` 11, `rxjs`, `@nestjs/config` 4, `@nestjs/typeorm` 11, `typeorm`, `pg`, `typeorm-naming-strategies`, `class-validator`, `class-transformer`, `@nestjs/jwt` 11, `@nestjs/throttler` 6, `argon2` 0.45, `google-auth-library` 11. `@nestjs/websockets` и `@nestjs/platform-ws` **11.2.7** (12.x — только ESM и для Nest 12), `ws` 8. Не установлено (понадобится позже): `firebase-admin` и т.д. — см. этапы в `TASKS.md`. Версии `@nestjs/config`, `@nestjs/typeorm` и `@nestjs/jwt` намеренно **не выше 4, 11 и 11** (см. MEMORY).

### Как читать раздел про `sync`

Порядок чтения: «Таблицы задач» (B2.1) → «Таблицы дневника» (B3.1) → «Приём `push`: тело и строки» (B2.2), «Проверка строк дневника» (B3.2) → писатели: задачи, отметки (B2.3–B2.4), настроения и метки (B3.3), заметки и связи (B3.4), «Удаления» (B2.5, B3.5) → «Маршрут `POST /sync/push`» (B2.6, B3.6) → «Маршрут `GET /sync/pull`» (B2.7, B3.7). Проверка по слоям: юнит-тесты логики решений (`src/sync/*.spec.ts`), e2e на писателях (`test/*-writer.e2e-spec.ts`, `test/deletion-*.e2e-spec.ts`), на маршрутах (`test/sync-push*.e2e-spec.ts`, `test/sync-pull*.e2e-spec.ts`) и сквозные по списку «Готово, когда» (`test/sync-scenarios.e2e-spec.ts` — задачи, `test/diary-scenarios.e2e-spec.ts` — дневник). Общая имитация приложения для сценариев «два устройства» — [test/support/fake-device.ts](test/support/fake-device.ts): в ней записаны правила, которым должно следовать настоящее приложение (см. «Сквозные тесты дневника» в `MEMORY.md`).

### Конфигурация (B0.2)

- [src/config/env.validation.ts](src/config/env.validation.ts) — класс `EnvironmentVariables` (правила проверки через `class-validator`) и `validateEnv`. `ConfigModule.forRoot({ isGlobal: true, validate: validateEnv })` в `AppModule`: при неверных переменных сервер не стартует и пишет, какая именно не подошла.
- Переменные: `NODE_ENV` (по умолчанию `development`), `PORT` (3000), `DATABASE_URL` (обязательна, `postgres://`/`postgresql://`), `SELF_PING_URL` (необязательна, `http(s)://…`), `JWT_SECRET` (обязательна, ≥ 32 символов — подпись токенов входа), `GOOGLE_CLIENT_IDS` (необязательна; список через запятую превращается в массив строк; не задана — вход через Google отклоняет любые токены). Образец — `.env.example`; настоящий `.env` в git не попадает.
- `FIREBASE_SERVICE_ACCOUNT` (B7.1, необязательна) — файл ключа сервисного аккаунта Firebase, закодированный в base64 одной строкой. Разбор — [src/config/firebase-account.ts](src/config/firebase-account.ts) (`parseServiceAccount`: нужны `type = service_account`, `project_id`, `client_email`, `private_key` в формате PEM). Не задана или пуста — push выключен, остальное работает. Задана, но сломана — `validateEnv` **останавливает запуск** (в том числе `migration:run` и Docker `CMD`) с текстом, который **не повторяет** ни ключ, ни то, что дали. Файл ключа в репозиторий не попадает (`*firebase-adminsdk*.json` в `.gitignore`).
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

### Таблицы задач (B2.1)

Миграция [CreateTaskTables](src/migrations/1793176217982-CreateTaskTables.ts); сущности [Task](src/tasks/task.entity.ts) и [TaskLog](src/tasks/task-log.entity.ts), модуль [TasksModule](src/tasks/tasks.module.ts) пока только регистрирует их. Тесты — [test/tasks-schema.e2e-spec.ts](test/tasks-schema.e2e-spec.ts).

| Таблица | Главное |
|---|---|
| `tasks` | PK `id` (uuid, создаёт устройство); `user_id` (удаляется вместе с пользователем); `parent_id` → `tasks.id`, **отложенный** внешний ключ (`deferrable initially deferred`: проверяется в конце транзакции, подзадача может прийти раньше родителя); проверки `status`, `repeat_type`, `tracking_mode`; `start_date` — `date`; `client_updated_at` (время правки на устройстве) и `updated_at` (ставит сервер); `deleted_at` |
| `task_logs` | PK `(task_id, user_id, date)` — отдельного id нет; `completed`, `value`, `completed_at`; `task_id` → `tasks` и `user_id` → `users` удаляются каскадом |

- Триггеры: `set_updated_at` на обеих таблицах; `blank_deleted_task` (на `tasks`, при вставке и обновлении строки с `deleted_at`: обнуляет данные — удалённая задача не может «ожить» повторной отправкой; отметки стирает **только при обновлении**, при вставке нельзя: триггер срабатывает до проверки конфликта и стёр бы отметки чужой задачи); `skip_log_of_deleted_task` (на `task_logs`: отметка к удалённой задаче молча не пишется, ошибки нет).
- Групповые колонки `group_id`, `assignee_id` добавлены в B5.1 (см. «Таблицы групп»). Базовый тест `schema.e2e-spec.ts` сверяет и эти сущности с миграцией.
- Что **не** проверяет база и должен проверять код: что отметку пишет владелец задачи (внешний ключ связывает отметку только с задачей, не с её хозяином) — это B2.4.

### Приём `push`: тело и строки (B2.2)

- [src/sync/dto/sync-push.dto.ts](src/sync/dto/sync-push.dto.ts) — тело описано мягко: три необязательных списка `tasks`, `logs`, `deleted`, в каждом **не больше 500** элементов (`400 batch_too_large`) и ничего не проверяется внутри элементов. Списки дневника (`moods`, `tags`, `entries`) принимаются и пишутся (B3.6); `cycle_days` — тоже по 500 (B4.4); остальное неизвестное отбрасывается проверкой тела (`whitelist`).
- [src/sync/push-rows.ts](src/sync/push-rows.ts) — `parseTask`, `parseLog`, `parseDeleted`, `parseCycleDay` (отказ называет **день** `YYYY-MM-DD`, а не uuid; симптомы: повторы убираются, порядок по возрастанию): каждая строка проверяется **сама по себе** и даёт либо чистый объект (`{row}`), либо отказ (`{id}` — uuid строки или `null`; произвольную строку клиента назад не отдаём). Правило: **всё, что база отвергла бы, отвергается здесь**, потому что ошибка базы откатывает весь `push`. Поэтому проверяются: перечисления, целые в пределах `int4`, минуты 0–1440, конечные числа, настоящий календарный день (`2026-02-30` — отказ), время только в UTC с `Z` (хранится исходной строкой — JS-дата отрезала бы микросекунды), `\0` в тексте (Postgres его не принимает), длины (`title` ≤ 1000, `description` ≤ 50 000, ключи ≤ 100), uuid приводится к нижнему регистру. Отсутствующее поле = значение по умолчанию как в базе; `null` для столбца с умолчанием (`title`, `status`, `tracking_mode`) — отказ. `user_id` из строки не читается вообще.
- [src/app.setup.ts](src/app.setup.ts) `configureBodyLimit` — лимит JSON-тела 5 МБ **только** для `/sync/push` (остальные маршруты — обычные 100 КБ). Вызывается из `main.ts` и `createTestApp`. Функция обёрнута намеренно: если подключить `express.json()` напрямую, Nest видит middleware с именем `jsonParser` и вообще не включает свой разбор тела для остальных маршрутов.
- Фильтр ошибок теперь узнаёт «клиентские» ошибки разбора тела (статус 4xx и `expose: true`): `413 payload_too_large` вместо 500.
- Тесты тела — [test/sync-push-body.e2e-spec.ts](test/sync-push-body.e2e-spec.ts) (идут через настоящий маршрут, см. «Маршрут push»).

### Запись задач (B2.3)

- [src/sync/plan-task-writes.ts](src/sync/plan-task-writes.ts) — `planTaskWrites(rows, userId, known)`: **без базы** решает, какие строки писать, а какие отказать. `known` — задачи, уже лежащие в базе под этими id, их родители и предки родителей. Правила по порядку: одна задача дважды в пакете → побеждает последняя; `group_id` не пуст → `groups_not_supported`; id занят чужой задачей → `id_taken`; своя уже удалённая → строка молча пропускается (остаётся пустой и удалённой, `updated_at` не меняется); родителя нет ни в пакете, ни у этого пользователя (чужой родитель = «нет») → `unknown_parent`; цепочка родителей замыкается на задачу (сама себе родитель, петля в пакете, петля через сохранённые задачи) → `parent_cycle`. Строки судятся все по одному состоянию, отказанные убираются разом, остальные судятся заново — так отказ родителя тянет за собой потомков, а участники петли получают `parent_cycle`, а не `unknown_parent`.
- [src/sync/task-writer.ts](src/sync/task-writer.ts) — `TaskWriter.write(manager, userId, rows)`: работает **внутри** транзакции `push` (её открывает B2.6). Запрос 1 — рекурсивный поиск: задачи пакета, их родители и предки (поднимается только по задачам этого пользователя). Запрос 2 — одна вставка всей пачки (`insert … on conflict (id) do update`), строки едут одним JSON-значением (`jsonb_to_recordset`). При обновлении **не меняются** `created_at`, `user_id`, `deleted_at`; остальное заменяется целиком (последняя запись побеждает — какая правка новее, решает приложение). Условие `where tasks.user_id = excluded.user_id` не даёт перезаписать чужую строку, даже если она появилась между проверкой и записью.
- [src/sync/rejection.ts](src/sync/rejection.ts) — коды отказов (`invalid_row`, `id_taken`, `unknown_parent`, `parent_cycle`, `unknown_task`, `unknown_label`, `unknown_group`, `not_allowed`, `unsupported_table`) и форма `{table, id, reason}`.
- [src/sync/sync.module.ts](src/sync/sync.module.ts) пока только поставляет `TaskWriter`; маршруты добавятся в B2.6–B2.7.
- Повторная отправка тех же задач **двигает `updated_at`** (триггер срабатывает на каждое обновление), поэтому другие устройства получат их при следующем `pull` ещё раз. Безвредно, но это лишний трафик; сравнение «изменилось ли что-то» не делалось.

### Запись отметок дня (B2.4, B5.8)

- [src/sync/plan-log-writes.ts](src/sync/plan-log-writes.ts) — `planLogWrites(rows, userId, tasks)`: без базы. Одна отметка (задача + день) дважды в пакете → побеждает последняя; **отметка всегда своя:** личную задачу отмечает только её хозяин, задачу группы — участник, который в группе сейчас, а если задача «для кого-то» — только этот человек (правило `can_mark_task`). Задачи нет, **или она чужая личная, или это задача группы, где тебя нет** (вышел, не был, группа удалена) → `unknown_task` (неотличимо от несуществующей: вызывающий ничего не узнаёт). Ты участник, но задача назначена другому (в том числе автору и владельцу) → `not_allowed`. Задача удалена → отметка молча пропускается, без отказа (постороннему и здесь `unknown_task`).
- [src/sync/log-writer.ts](src/sync/log-writer.ts) — `LogWriter.write(manager, userId, rows)`: в транзакции `push` **после** записи задач (поэтому видит задачи этого же пакета). Запрос 1 — про задачи, на которые ссылаются отметки: хозяин, группа, исполнитель, удалена ли, участник ли ты; запрос 2 — одна вставка пачки (`jsonb_to_recordset`), ключ `(task_id, user_id, date)` (у каждого участника своя отметка за день). Правило доступа продублировано в SQL: вставка идёт через `join tasks … t.deleted_at is null and can_mark_task(t.id, $2)`, так что отметка не попадёт туда, где её нельзя поставить, даже если проверка перед ней обманута. Третий слой — триггер `skip_unmarkable_log`. Тест «последней линии» отключает триггер и подменяет планировщик, чтобы доказать, что второй слой держит сам.
- [src/sync/cycle-writer.ts](src/sync/cycle-writer.ts) — `CycleWriter.write(manager, userId, rows)`: в транзакции `push`, **один** запрос на любое число дней (`jsonb_to_recordset`, upsert по `(user_id, date)`). `user_id` — только `$2` из токена, в JSON его нет, поэтому чужой день недостижим по самому ключу. День заменяется **целиком**, в том числе пустым (он сохраняется строкой). Один день дважды в пакете — побеждает последний (в памяти, иначе `insert … on conflict` упал бы). Отказов не бывает, возвращает `void`. Вызывается из `SyncPushService` после отметок и перед удалениями, в той же транзакции.
- В `rejected` отметка называется `task_logs` (имя таблицы базы, как и в `deleted[].table`), а `id` — id её задачи: у отметки своего id нет, день в ответ не попадает.
- Групповые задачи (B5) изменят правило: участник группы сможет писать отметку в групповую задачу; пока все задачи личные.

### Удаления (B2.5, B3.5)

- [src/sync/deletion-writer.ts](src/sync/deletion-writer.ts) — `DeletionWriter.write(manager, userId, rows)`, в транзакции `push` **после** всего, что записывается. Понимает таблицы `tasks`, `diary_entries`, `note_tags`, `note_moods` (имена таблиц базы; список — константа `TABLES`, в SQL попадают только они). **Один запрос** на все названные таблицы сразу: для каждой часть `insert (id, user_id, deleted_at) … on conflict (id) do update … where таблица.user_id = excluded.user_id and таблица.deleted_at is null`. Так: id, которого сервер не видел, становится «надгробием» (позднее пришедшая строка не оживёт — писатели пропускают удалённые); своя живая строка помечается удалённой, триггер обнуляет её и стирает отметки/связи; своя уже удалённая не трогается вовсе (повтор безвреден, `updated_at` не двигается); чужая не трогается, а её id возвращается завершающими `select … where user_id is distinct from $1` (именно `is distinct from`: у стартового настроения владельца нет, а `null <> x` — не «истина») и уходит в `rejected` как `id_taken`.
- Стартовое настроение удалить нельзя никому: `id_taken`, строка и её связи целы, ошибки нет (обновления нет, значит триггер базы молчит).
- Любая другая таблица (`cycle_days`, `task_logs`, что угодно; дней цикла удалять нельзя вовсе) → `unsupported_table`, имя таблицы и id возвращаются как есть, ничего не создаётся. Имя таблицы сравнивается точно.
- Подзадачи удалённой задачи сервер сам не удаляет (приложение шлёт каждую). Удаление метки или настроения стирает их связи во всех заметках, но **сами заметки не трогает** (их `updated_at` не меняется): другие устройства узнают об этом из удалённой метки в `pull` и убирают связь у себя.
- Тесты: [test/deletion-writer.e2e-spec.ts](test/deletion-writer.e2e-spec.ts) (задачи), [test/deletion-diary.e2e-spec.ts](test/deletion-diary.e2e-spec.ts) (дневник).

### Маршрут `POST /sync/push` (B2.6, B3.6)

- [src/sync/sync.controller.ts](src/sync/sync.controller.ts) → [src/sync/sync-push.service.ts](src/sync/sync-push.service.ts). Закрыт токеном (как всё по умолчанию); `user_id` берётся из токена. Ответ `200` `{rejected: [{table, id, reason}], server_time}`. Заголовок `X-Device-Id` принимается и ничего не делает (нужен будет в B6).
- Порядок: (1) каждая строка проходит свой разборщик (`parseMood`/`parseTag`/`parseEntry`/`parseTask`/`parseLog`/`parseDeleted`) — плохие идут в `rejected` как `invalid_row`; (2) записи в **одной транзакции**: настроения → метки → заметки со связями → задачи → отметки → удаления (заметка может ссылаться на метку того же запроса, отметка — на новую задачу, удаление идёт последним и побеждает всё, что записано до него); (3) ответ. Ошибка базы откатывает всё и даёт `500 internal_error` — приложение пошлёт пакет снова (запись идемпотентна).
- Если после проверки писать нечего (пустой запрос, только плохие строки) — транзакция **не открывается**, база не трогается.
- Имена таблиц в `rejected`: `tasks`, `task_logs` (id = id задачи), `note_moods`, `note_tags`, `diary_entries`, `deleted` (плохая запись списка `deleted`, id если читается), `cycle_days` (`invalid_row`, `id` — сам день `YYYY-MM-DD`, либо `null`, если день не читается); для удалений — имя таблицы, как прислали. Причины: `invalid_row`, `id_taken`, `unknown_parent`, `parent_cycle`, `unknown_task`, `unknown_label` (заметка сохранена без негодной связи), `groups_not_supported`, `unsupported_table`.
- `server_time` — часы сервера приложения (не базы), только для сведения; водяная отметка для `pull` — это `next` из `GET /sync/pull`, не `server_time`.
- Число запросов к базе фиксировано: настроения 2, метки 2, заметки 3, задачи 2, отметки 2, удаления 1, плюс `BEGIN`/`COMMIT` (≈ 12 круговых запросов на самый полный `push`; каждый ≈ 50 мс на Render + Neon).
- Тесты: [test/sync-push.e2e-spec.ts](test/sync-push.e2e-spec.ts), [test/sync-push-diary.e2e-spec.ts](test/sync-push-diary.e2e-spec.ts), тело — [test/sync-push-body.e2e-spec.ts](test/sync-push-body.e2e-spec.ts).

### Маршрут `GET /sync/pull` (B2.7, B3.7)

- [src/sync/sync.controller.ts](src/sync/sync.controller.ts) → [src/sync/sync-pull.service.ts](src/sync/sync-pull.service.ts); параметры — [src/sync/dto/sync-pull.query.ts](src/sync/dto/sync-pull.query.ts): `since` (UTC-момент с `Z`, как `next`; пусто = всё), `include` (`tasks`/`diary`/`cycle` через запятую), `limit` (целое 1–1000, по умолчанию 500). Всё остальное — `400 validation_failed`.
- **Части ответа.** Всегда: `tasks`, `logs` (задачи и их отметки). С `include=diary` добавляются `moods`, `tags`, `entries`. Без `diary` этих ключей в ответе **нет**. С `include=cycle` добавляется `cycle_days` (форма плана 4.2: `date`, `flow`, `mood`, `symptoms` списком чисел, `discharge`, `sex`, `pill`, `note`, `client_updated_at`, `updated_at`; **без** `user_id`); без `cycle` ключа нет, с `cycle` и без дней — пустой список. Пустой день приходит обычной строкой. Страница цикла — как у остальных (по `limit`, без разрезания одинаковых `updated_at`), в расчёте `next`/`has_more` участвуют уже шесть частей. Ответ: `{next, has_more, tasks, logs, groups, moods?, tags?, entries?, cycle_days?}`; `groups` — **всегда** (снимок групп, см. ниже). Только **свои** строки (`user_id` из токена), кроме стартовых настроений (без владельца): они приходят всем.
- Строка задачи — ключи `taskToRow` + `user_id`, `updated_at`, `deleted_at` (+ `group_id`/`assignee_id`, пока `null`); отметки — ключи `logToRow` + `user_id`, `updated_at`. Строки дневника — по плану, **без** `user_id`: настроение `{id, name, emoji, created_at, client_updated_at, updated_at, deleted_at}`, метка `{id, name, color_key, …те же времена}`, заметка `{id, title, body, cover_image, images, is_favorite, status, времена…, mood_ids, tag_ids}` (списки uuid отсортированы, `[]` если меток нет). Удалённая строка приходит пустой с `deleted_at`.
- Времена — **текстом с шестью знаками микросекунд** (`2026-03-01T10:00:00.123457Z`), дни — `YYYY-MM-DD`, оба собираются в SQL (`to_char`), не через JS-даты. Сравнение «новее `since`» — до микросекунды.
- **Страница каждой части:** строки с `updated_at > since` по возрастанию, не меньше `limit` (если столько есть) и **до конца группы с одинаковым временем** на границе — иначе следующий запрос «строго новее» их потерял бы. Страница заметок не больше **50** при любом `limit` (`maxPage`): заметки тяжёлые, `has_more` добирает остальное. `has_more` — обрезана ли хоть одна часть. `next`: обрезаны части → самое раннее из их последних времён; иначе самое позднее из всех присланных строк; строк нет → `since` (или `null`, если и его нет).
- Все части читаются параллельно (до 5 запросов сразу — весь пул соединений: терпимо для личного сервера); каждый запрос идёт по индексу `(user_id, updated_at)` (`with … as not materialized`). Связи заметки собираются подзапросом только для строк, которые попали на страницу.
- Тесты: [test/sync-pull.e2e-spec.ts](test/sync-pull.e2e-spec.ts) (задачи), [test/sync-pull-diary.e2e-spec.ts](test/sync-pull-diary.e2e-spec.ts) (дневник); точное время для тестов задаётся прямым `update` с отключённым триггером.

### Запись заметок и связей (B3.4)

- [src/sync/plan-entry-writes.ts](src/sync/plan-entry-writes.ts) — `planEntryWrites(rows, userId, known)`: без базы. Заметка: одна дважды в пакете → побеждает последняя (вместе со связями); id чужой → `id_taken`, связей нет; своя удалённая → молча пропускается (остаётся пустой, связи не добавляются и не стираются); иначе пишется. Связи: если в строке есть `mood_ids`/`tag_ids`, связи этой заметки **заменяются** этим списком (пустой стирает), если поля нет (`null`) — остаются как были. Настроение годится, если оно стартовое или своё и не удалено; метка — если своя и не удалена. Негодная связь отбрасывается, заметка сохраняется, в `rejected` одна запись `{table: diary_entries, id: заметки, reason: unknown_label}` на заметку.
- [src/sync/entry-writer.ts](src/sync/entry-writer.ts) — `EntryWriter.write(manager, userId, rows)`: в транзакции `push`, **после** настроений и меток (заметка может ссылаться на созданные в том же запросе). Запрос 1 — хозяева заметок, настроений и меток пакета разом; запрос 2 — одна вставка заметок; запрос 3 — все связи одним запросом с частями `add_moods`, `add_tags`, `drop_moods`, `drop_tags`: вставляются недостающие пары (`on conflict do nothing`), удаляются пары, которых в новом списке нет. Нельзя «удалить всё и вставить заново» в одном запросе: части видят одно и то же состояние и столкнулись бы на парах, которые остаются.
- Второй слой доступа в самом SQL: вставка связи идёт через соединения «заметка — своя и живая», «метка — своя и живая», «настроение — стартовое или своё и живое»; удаление связей — только у заметок вызывающего. Поэтому даже обманутая проверка не прицепит чужую метку и не сотрёт связи чужой заметки.
- Тесты: [test/entry-writer.e2e-spec.ts](test/entry-writer.e2e-spec.ts) (43), юнит — `src/sync/plan-entry-writes.spec.ts` (18).

### Запись настроений и меток (B3.3)

- [src/sync/plan-label-writes.ts](src/sync/plan-label-writes.ts) — `planLabelWrites(table, rows, userId, known)`: без базы. Правила: один id дважды в пакете → побеждает последняя; id уже есть у **другого** пользователя, **или это стартовое настроение** (владельца нет) → `id_taken` (таблица `note_moods`/`note_tags` в отказе); своя уже удалённая → молча пропускается (остаётся пустой и удалённой, `updated_at` не двигается).
- [src/sync/label-writer.ts](src/sync/label-writer.ts) — `LabelWriter.writeMoods` / `writeTags(manager, userId, rows)`: в транзакции `push`, **до** заметок. Запрос 1 — кто хозяин этих id; запрос 2 — одна вставка пачки (`jsonb_to_recordset`). При обновлении не меняются `created_at`, `user_id`, `deleted_at`; условие `where таблица.user_id = excluded.user_id` не даёт перезаписать чужую строку и стартовое настроение (у него `user_id` пустой, а пустое ни с чем не равно — обновления нет, значит и триггер базы молчит).
- Тесты: [test/label-writer.e2e-spec.ts](test/label-writer.e2e-spec.ts) — общий набор для настроений и меток (`describe.each`) + отдельный блок про стартовые настроения.

### Проверка строк дневника (B3.2)

- [src/sync/push-rows.ts](src/sync/push-rows.ts): `parseEntry`, `parseMood`, `parseTag` по тем же правилам, что у задач (каждая строка сама по себе; `{row}` или `{id}`; всё, что отвергла бы база, отвергается здесь; `user_id` не читается; одинокие суррогаты → U+FFFD).
- Пределы: `title` ≤ 1000, `body` ≤ 1 000 000, `cover_image` ≤ 2048, `images` ≤ 100 000 символов (текст, не список), `status` — `draft`/`normal`/`archived`; название настроения/метки ≤ 100, эмодзи ≤ 32, `color_key` ≤ 100 (по умолчанию `violet`, `null` — отказ); `mood_ids`/`tag_ids` — до 100 uuid в каждом, в нижнем регистре, без повторов.
- **Связи заметки:** поле не прислано или `null` → `moodIds`/`tagIds` = `null`, «связи не трогать»; `[]` → «стереть все»; список → «заменить на эти». Одно некорректное значение в списке (не uuid, не массив) делает `invalid_row` всей заметке.
- Разборщики подключены к `push` в B3.6.

### Запись групповых задач в `push` (B5.7)

- **Новая задача с `group_id`:** группа должна существовать, не быть удалённой, а ты — действующим участником, иначе `unknown_group` (для «нет такой группы» и «ты не в ней» ответ одинаковый). Автор — всегда пользователь из токена (`user_id` в строке не читается). Исполнитель, которого нет в группе (не участник, вышел, не существует), молча обнуляется — отказа нет.
- **Задача уже есть:** права проверяются по **сохранённой** группе, присланный `group_id` игнорируется, и строка пишется с сохранённой группой (`planTaskWrites` подменяет её). Править может **автор** или **владелец группы**, и только тот, кто в группе сейчас. Другой участник → `not_allowed`; посторонний и вышедший (даже автор) → `id_taken`. Автор и группа не меняются никогда. Чужая личная задача → `id_taken`, как и раньше; личная задача остаётся личной, что бы ни называла строка.
- **Форма.** Групповая задача — одноразовая: повтор, родитель, режим «значение» → `invalid_row`; это проверяется и для строки без `group_id`, если сохранённая задача групповая (иначе база отказала бы и откатила весь `push`). Подзадача под групповой задачей → `unknown_parent`.
- **Удаление** (`deleted`, `tasks`): автор (в группе) или владелец группы; другой участник → `not_allowed`; посторонний, вышедший (даже автор) и любой после удаления группы → `id_taken`. Повтор безвреден. Удаление по-прежнему побеждает запись того же запроса и «надгробие» неизвестного id.
- **Последняя линия — в SQL** ([task-writer.ts](src/sync/task-writer.ts), [deletion-writer.ts](src/sync/deletion-writer.ts)): вставка новой групповой задачи требует участия; обновление — «личная своя, либо групповая и ты в группе и (автор или владелец)»; удаление — то же условие `TASK_MAY_DELETE`. Тесты подменяют планировщик пропускающим всё и проверяют, что база сама ничего лишнего не меняет. Ещё одну страховку держит триггер `tasks_guard_group` (автор и группа неизменны).
- Новые причины отказа: `unknown_group`, `not_allowed`; `groups_not_supported` убрана.

### Групповые задачи и чужие отметки в `pull` (B5.6)

- Задачи в ответе: **свои личные** (`user_id = ты`, `group_id` пуст) **и** все задачи групп, где ты действующий участник, чей бы автор ни был ([sync-pull.service.ts](src/sync/sync-pull.service.ts), `TASKS_PART`). В строке `user_id` — автор, `group_id` и `assignee_id` настоящие (у личной задачи оба `null`).
- Отметки: свои на личных задачах **и** отметки всех участников на задачах твоих групп (`LOGS_PART`) — это «2 из 3». В отметке `user_id` — тот, кто её поставил.
- Всё, что относится к группе, пропадает у человека, как только он перестал быть участником (вышел, убран, группа удалена): и чужие задачи, и **его собственные** задачи и отметки в этой группе — они остаются у группы, но ему не отдаются. Вернулся по коду — снова приходят.
- Удалённая групповая задача приходит пустой строкой с `deleted_at`, `group_id` остаётся, исполнитель `null`; её отметки стёрты.
- **Две ветки вместо `or`.** Часть читается как `union all` двух непересекающихся выборок (`Part.alsoOwner`): личное по индексу `(user_id, updated_at)`, групповое по `tasks (group_id, updated_at)` и по ключу отметок. Одна проверка через `or` отправляла планировщика читать таблицу целиком. Замер на 52 тыс. задач и 240 тыс. отметок (локально): задачи — 3 мс (было бы 17), отметки — 46 мс первая загрузка и 30 мс «ничего нового» (было бы 98 и 63).
- Новому участнику старые строки группы приходят благодаря «трогаю» при вступлении (B5.3); проверено сквозным тестом.

### Снимок `groups` в `pull` (B5.5)

- В **каждом** ответе `GET /sync/pull` (на любой странице, при любых `since`, `limit`, `include`) есть `groups: {groups: [{id, name, owner_id}], members: [{group_id, user_id, display_name, avatar_url}]}` ([sync-pull.service.ts](src/sync/sync-pull.service.ts), `GROUPS_SQL`). У человека без групп — `{groups: [], members: []}`.
- **Целиком, не по `since`:** только группы, где ты действующий участник и которые не удалены, и в них только действующие участники. Группа, пропавшая из ответа, — единственный сигнал телефону «вышел / убрали / группу удалили», и телефон сам убирает её задачи. В расчёте `next` и `has_more` снимок не участвует и страниц не имеет.
- Имя и картинка — из `profiles` **на момент запроса** (нет профиля — `null`); смена имени видна со следующего `pull`, ждать штампов не нужно. Кода приглашения, роли, штампов и почты в снимке нет.
- Порядок: группы от старых к новым, участники в порядке вступления (владелец первым). Один запрос на всё (группы × участники плоским списком), собирается в коде.
- Параллельно с остальными частями; теперь `pull` с дневником и циклом использует до **7** соединений сразу при пуле в 5 (лишние встают в очередь на доли секунды).

### Выйти, исключить, удалить группу (B5.4)

- Три маршрута в [groups.controller.ts](src/groups/groups.controller.ts) → [groups.service.ts](src/groups/groups.service.ts), все закрыты токеном, все отвечают `204` без тела:
  - `POST /groups/:id/leave` — выходит участник. Владелец → `409 owner_cannot_leave` (он удаляет группу).
  - `DELETE /groups/:id/members/:memberId` — только владелец. Себя → `409 owner_cannot_leave`. Не участник этой группы (и никогда не был) → `404 not_found`.
  - `DELETE /groups/:id` — только владелец; участник → `403 not_owner`.
- **Что происходит при выходе и исключении** (`dropMember`, одна транзакция): участнику ставится `deleted_at` (строка остаётся); задачи группы, назначенные ему, становятся «ничьими» (`assignee_id = null`) и получают новое `client_updated_at` — иначе телефон со старой неотправленной правкой выиграл бы слияние и назначил бы его обратно. Его собственные задачи (он их автор) и его отметки остаются, остальные участники их видят. Другие группы человека не затрагиваются.
- **Удаление группы** (одна транзакция): `groups.deleted_at`, `deleted_at` у всех участников, `deleted_at` и `client_updated_at` у живых задач — триггер `blank_deleted_task` обнуляет их и стирает отметки всей группы. `group_id` и автор у удалённых задач остаются. Уже удалённые задачи не трогаются. Строки не удаляются, чтобы телефон, который был выключен, узнал об этом.
- **Повторы безвредны.** У того, у кого есть строка участия (любая), повторный выход / исключение / удаление группы → `204` и **без новых штампов** (владелец удалённой группы тоже). Посторонний, неизвестная группа и id не в формате uuid → `404`, как везде в группах. Бывший участник после удаления группы или своего выхода при `DELETE /groups/:id` получает `404`, при повторном `leave` — `204`.
- После выхода / удаления человеку закрыты код, переименование, исключение: везде `404`.

### Вступление по коду (B5.3)

- `POST /groups/join` `{code}` → `200 {id}` ([groups.service.ts](src/groups/groups.service.ts), `join`; тело — [JoinGroupDto](src/groups/dto/join-group.dto.ts): строка до 64 символов, иначе `400 validation_failed` и попытка **не** считается). Всё — одна транзакция, начинается с **блокировки на аккаунт** (`pg_advisory_xact_lock`): параллельные запросы одного человека идут по очереди, иначе сто запросов разом прошли бы проверку счётчика до того, как записалась хоть одна неверная попытка.
- Порядок: (1) счётчик неверных за последний час ≥ 10 → `429 too_many_requests` **до** поиска кода (правильный код при исчерпанном лимите тоже отказывается и не вступает); (2) ввод очищается от всего, кроме цифр ASCII; код ищется среди **не удалённых** групп; (3) нет такого → строка в `group_join_failures` (+ подчистка записей этого аккаунта старше суток) и `400 bad_code`; (4) уже действующий участник (в том числе владелец) → `{id}`, ничего не меняется; (5) иначе строка участника создаётся или **оживает** (`deleted_at = null`, `joined_at = now()`, роль `member`) и «трогаются» живые задачи группы и все их отметки.
- **Неверная попытка переживает отказ:** транзакция не бросает ошибку изнутри (бросок откатил бы только что записанную попытку), а возвращает исход и бросает уже после коммита.
- **«Трогание» устроено проще, чем в старом SQL:** участников не трогаем (список участников `pull` отдаёт целиком каждый раз), удалённые задачи не трогаем (новичку они не нужны). Содержимое строк и `client_updated_at` не меняются — двигается только `updated_at` (ставит триггер).
- Триггер отметок `skip_unmarkable_log` теперь не проверяет **обновление, оставляющее ключ отметки прежним** (задача и пользователь те же): иначе «трогание» молча пропускало бы отметки вышедших участников. Вставка (в том числе первая часть upsert) проверяется как прежде; смена задачи или пользователя в отметке по-прежнему пропускается.

### Группы: создание, имя, код (B5.2)

- [src/groups/groups.controller.ts](src/groups/groups.controller.ts) → [src/groups/groups.service.ts](src/groups/groups.service.ts). Все четыре маршрута закрыты токеном; кто вызывает — всегда пользователь из токена (в теле владельца нет, лишние поля отбрасываются).
  - `POST /groups` `{name}` → `201 {id}`: в **одной транзакции** группа, строка владельца (`role = 'owner'`) и код; не вышло получить свободный код — откат, ничего не остаётся.
  - `PATCH /groups/:id` `{name}` → `204` без тела (приложение после действия само запускает синхронизацию).
  - `GET /groups/:id/invite` → `{code}`; `POST /groups/:id/invite/regenerate` → `200 {code}` (старый код сразу перестаёт работать, вступившие остаются).
- **Кто что видит:** группа, которой нет, удалена, или в которой тебя нет (не участник / вышел / исключён), и id не uuid — одинаково `404 not_found` (посторонний ничего не узнаёт); участник, но не владелец — `403 not_owner`. Одна проверка `requireOwner` на три маршрута.
- Имя: обрезается по краям, 1–100 символов, иначе `400 validation_failed` ([GroupNameDto](src/groups/dto/group-name.dto.ts)).
- Код: [invite-code.ts](src/groups/invite-code.ts) — 6 цифр, байты ≥ 250 выбрасываются (без перекоса); занят — тянется новый (до 10 раз). Создание — `insert … on conflict do nothing`; смена — `update … where not exists`. Известное ограничение: при **одновременном** одинаковом выборе двумя группами смена даст `500` (помечено `shortcut:` в коде).
- **Ловушка:** `dataSource.query` для `update … returning` отвечает парой `[строки, число]`, для `insert … returning` — просто строками.

### Таблицы групп (B5.1)

Миграция [CreateGroups](src/migrations/1793195437182-CreateGroups.ts); сущности [Group](src/groups/group.entity.ts), [GroupMember](src/groups/group-member.entity.ts), [GroupInvite](src/groups/group-invite.entity.ts), [GroupJoinFailure](src/groups/group-join-failure.entity.ts), модуль [GroupsModule](src/groups/groups.module.ts) пока только регистрирует их (маршруты `/groups/*` — B5.2 и дальше). Тесты — [test/groups-schema.e2e-spec.ts](test/groups-schema.e2e-spec.ts) и поправленный [test/tasks-schema.e2e-spec.ts](test/tasks-schema.e2e-spec.ts).

| Таблица | Что |
|---|---|
| `groups` | PK `id` — **создаёт сервер** (`gen_random_uuid()`); `name` 1–100; `owner_id` → `users` (каскад: удалили аккаунт владельца — ушла и группа); `deleted_at` (мягкое удаление); `updated_at` — триггер |
| `group_members` | PK `(group_id, user_id)`; `role` `owner`/`member`; владелец тоже строка; `deleted_at` — вышел / убран / группа удалена (тот же ряд оживает при возвращении); оба внешних ключа каскадом; индекс по `user_id` («мои группы»); `updated_at` — триггер |
| `group_invites` | PK `group_id` (один код на группу); `code` — ровно 6 цифр (`check`), уникален; **без** `updated_at` (в `pull` не ходит) |
| `group_join_failures` | неверные попытки кода: `id` (счётчик), `user_id` (каскад), `at`; индекс `(user_id, at)` для «сколько за последний час» |
| `tasks` (+2 колонки) | `group_id` → `groups` (каскад), `assignee_id` → `users` (**обнуляется** при удалении аккаунта); проверки `tasks_group_task_shape` (групповая — одноразовая: без повтора, подзадач, режима «значение») и `tasks_assignee_needs_group`; индекс `(group_id, updated_at)` под выборку группы |

- Функции базы: `is_group_member(g, u)` (действующий участник), `can_mark_task(t, u)` (личная — её хозяин; групповая — участник, и задача «для всех» или назначена ему; **`null`**, если задачи нет вовсе).
- Триггеры: `tasks_guard_group` (на `tasks`: `user_id` и `group_id` после создания **не меняются** — у любой задачи; исполнитель не из группы **молча обнуляется**, строку не отказываем); `blank_deleted_task` теперь обнуляет и `assignee_id`, а `group_id` оставляет (по нему телефоны участников узнают, чья это удалённая задача); `skip_unmarkable_log` вместо прежнего `skip_log_of_deleted_task` (на `task_logs`: молча пропускает отметку к удалённой задаче **и** отметку, которую `can_mark_task` запрещает; неизвестная задача проходит, чтобы внешний ключ отказал громко).
- Правила «кто что пишет» (автор / владелец группы / участник) — **в коде** (B5.7, B5.8); база держит последнюю линию.
- Миграция проверена на откат (`down`) и повторное применение.

### Таблица цикла (B4.1)

Миграция [CreateCycleDays](src/migrations/1793189679597-CreateCycleDays.ts); сущность [CycleDay](src/cycle/cycle-day.entity.ts), модуль [CycleModule](src/cycle/cycle.module.ts) пока только регистрирует её. Тест — [test/cycle-schema.e2e-spec.ts](test/cycle-schema.e2e-spec.ts).

| Колонка | Что |
|---|---|
| `user_id`, `date` | **ключ строки** (составной): по строке на день на пользователя; отдельного `id` нет. `user_id` удаляется вместе с пользователем. `date` — `date` (день, не момент) |
| `flow` | 0–4, не пусто, по умолчанию 0 |
| `mood` | 0–5 или пусто |
| `symptoms` | массив `smallint`, каждый элемент 0–8, не пусто (пустой список `{}` — по умолчанию) |
| `discharge` | 0–6 или пусто |
| `sex` | 0–2 или пусто |
| `pill` | логическое, по умолчанию «нет» |
| `note` | текст или пусто |
| `client_updated_at`, `updated_at` | время правки на устройстве и время сервера (триггер `set_updated_at`) |

- **Удалений нет**: нет `deleted_at`, нет триггеров обнуления. Снять отметку = сохранить день пустым (flow 0, остальное пусто, `symptoms` `{}`, `pill` false, `note` null); пустой день — обычная строка, которую получат другие устройства.
- Варианты — индексы в списках приложения; границы в `check`-ограничениях как в старой базе. Новый вариант в приложении = `alter` ограничения **до** выпуска приложения.
- Данные медицинские: только владелец; никакие групповые правила (B5) эту таблицу называть не должны.
- Индекс `(user_id, updated_at)` под вопрос «моё, изменённое после X»; ключ `(user_id, date)` обслуживает чтение по пользователю.

### Таблицы дневника (B3.1)

Миграция [CreateDiaryTables](src/migrations/1793180334682-CreateDiaryTables.ts); сущности — [src/diary/](src/diary/), модуль [DiaryModule](src/diary/diary.module.ts) пока только регистрирует их. Тест — [test/diary-schema.e2e-spec.ts](test/diary-schema.e2e-spec.ts).

| Таблица | Главное |
|---|---|
| `diary_entries` | PK `id` (uuid от устройства); `user_id`; `title`, `body` (JSON «Delta» текстом), `cover_image`, `images` (JSON-список текстом, по умолчанию `[]`), `is_favorite`, `status` (`draft`/`normal`/`archived`); `created_at`, `client_updated_at` (время правки на устройстве), `updated_at` (ставит сервер), `deleted_at` |
| `note_moods` | настроения; **`user_id` может быть пустым** — так записаны 8 стартовых настроений (общие, без владельца); `name`, `emoji`, времена, `deleted_at` |
| `note_tags` | метки; `name`, `color_key` (по умолчанию `violet`), времена, `deleted_at` |
| `diary_entry_moods`, `diary_entry_tags` | связи «заметка ↔ настроение/метка»: ключ `(entry_id, mood_id)` / `(entry_id, tag_id)` + `user_id`; ни id, ни времён — связь едет внутри заметки; при настоящем удалении родителя уходят каскадом |

- Триггеры: `set_updated_at` на трёх таблицах; `blank_deleted_diary_entry`, `blank_deleted_note_tag`, `blank_deleted_note_mood` (при вставке и обновлении строки с `deleted_at`: обнуляют содержимое — текст, картинки, имя; связи стирают **только при обновлении**, не при вставке: триггер `before insert` срабатывает до проверки конфликта и стёр бы связи чужой заметки; урок B2.5); `forbid_change_of_starter_mood` (на `note_moods`: нельзя изменять и удалять строки без владельца и нельзя присвоить владельца, в том числе из кода; `truncate` триггеры обходит).
- **Сид**: 8 стартовых настроений вставляет сама миграция (uuid, названия, эмодзи один в один из `lib/utils/note_labels.dart` приложения; в тесте они выписаны отдельно и сверяются с базой). Менять их нельзя: другой uuid — другое настроение на всех устройствах, где старое уже есть. Девятое — миграцией и правкой приложения вместе.
- `truncateAll` в тестах сохраняет и возвращает стартовые настроения.
- Что не проверяет база и должен проверять код (B3.3–B3.4): что метку в заметку цепляет её владелец, и что настроение — стартовое или своё (внешние ключи связывают родителей по отдельности, а не по владельцу).

### Таблица `device_tokens` (B7.2)

Миграция [CreateDeviceTokens](src/migrations/1793276328511-CreateDeviceTokens.ts); сущность [DeviceToken](src/devices/device-token.entity.ts), модуль [DevicesModule](src/devices/devices.module.ts) и маршруты (B7.3): [DevicesController](src/devices/devices.controller.ts), [DevicesService](src/devices/devices.service.ts), [DeviceTokenDto](src/devices/dto/device-token.dto.ts).

- Одна строка на **телефон**: ключ — токен FCM (`token`, текст), `user_id` — кто сейчас на нём вошёл (внешний ключ на `users`, при удалении аккаунта токены уходят каскадом), `updated_at` — триггером `set_updated_at`. Токен всегда принадлежит ровно одному аккаунту; переход к тому, кто вошёл последним, делает маршрут через `insert … on conflict (token) do update`, сама таблица лишь не допускает двух владельцев.
- Длина токена 20–4096 проверяется **и в таблице** (`device_tokens_token_length`), и в маршруте.
- Индекс `device_tokens_user_id_idx` — под «все телефоны этого человека» (читается при каждой отправке).
- Токены никогда не отдаются клиенту и никем не перечисляются.
- `PUT /devices` `{token}` → `204`: токен становится собственностью того, чей access-токен пришёл (`insert … on conflict (token) do update set user_id`), даже если принадлежал другому — так и задумано, «кто вошёл последним»; повтор безвреден. `DELETE /devices` `{token}` → `204`: удаляется **только свой** токен, чужой и несуществующий дают тот же ответ (ничего не выдаём). Оба закрыты токеном; `user_id` — только из access-токена. `400 bad_token` на любую беду с токеном (не строка, длина вне 20–4096, не видимые ASCII без пробела); `401`, если аккаунта уже нет.

### Отправитель push (B7.4)

[src/push/push-sender.ts](src/push/push-sender.ts) (`PushSender`) и [PushModule](src/push/push.module.ts). Отделён от правил «кому что слать» (B7.5–B7.7), чтобы в тестах на его месте стоял поддельный и сеть не трогалась.

- `send(token, {title, body, data})` → `'sent' | 'unregistered' | 'failed'`; **не бросает**. `enabled` — есть ли ключ. При старте одна строка в логе: push включён (название проекта) или выключен.
- Токен доступа Google — `JWT` из `google-auth-library` (область `firebase.messaging`), кэшируется библиотекой; запрос — `POST https://fcm.googleapis.com/v1/projects/<project_id>/messages:send`, `notification` + `data` (строки) + `android: {priority: HIGH, notification: {channel_id: group_activity}}`. Канал должен совпадать с тем, что создаёт приложение (`groupChannelId` в `app_notifications.dart`).
- `unregistered` — только если в `error.details[].errorCode` есть `UNREGISTERED`. Всё остальное (в том числе 404 без этого кода, 400, 403, 429, 5xx, обрыв, таймаут) — `failed`, и токен **не** трогается: ошибка может быть нашей.
- Таймаут 10 с на токен доступа и на запрос. В лог не попадают: токен телефона, токен доступа, ключ, текст ошибки FCM.
- Швы для тестов: `createAuth` (защищённый метод), поддельный `fetch`. В тестах приложения push выключен принудительно (`test/support/env.ts`).

### Правила уведомлений (B7.5)

[src/push/plan-push.ts](src/push/plan-push.ts): `planPush(events, world)` — чистая функция: какому человеку какое сообщение, и ничего больше. Правила продублированы в трёх местах и менять их надо вместе: приложение (`lib/utils/group_events.dart`), этот файл, эталон `reference/sql/013_push_triggers.sql`.

- События (`PushEvent`): `created` (задача появилась), `assigned` (исполнитель стал другим человеком), `done` (отметка стала выполненной); что именно произошло, определяют писатели (B7.6). Мир (`PushWorld`): `now`, группы (название и действующие участники), имена.
- Новая задача: час (по `created_at` из строки; ровно час — ещё новость), не подзадача, не удалена, `status = active`; всем участникам, кроме автора; для «кого-то» — только ему. Переназначение: только новому исполнителю, час не проверяется. Выполнена: «Выполнено: {имя}», всем, кроме отметившего; для «кого-то» — только автору.
- Тексты: «Новая задача для всех от {имя}» / «Новая задача от {имя}» (имя — **автора задачи**, а не того, кто переназначил), текст «{задача} · {группа}»; название задачи показывается до 200 символов, дальше «…»; `data`: `group_id`, `task_id` строками.
- Потолок: не больше 10 уведомлений одному получателю за один вызов, считается отдельно на каждого и по всем видам событий вместе, побеждают первые.

### Что изменилось: события писателей (B7.6)

[src/sync/task-writer.ts](src/sync/task-writer.ts) и [src/sync/log-writer.ts](src/sync/log-writer.ts) умеют сообщать `PushEvent`-ы (тип — в `src/push/plan-push.ts`), если им передали массив четвёртым параметром: `write(manager, userId, rows, events?)`. Без него работают как раньше.

- Одним запросом: CTE `before` (состояние на начало запроса) + `written` (`insert … on conflict … returning`, то есть записанное и уже **после** триггеров) + внешний `select`, который оставляет только групповые задачи. Число запросов не выросло.
- `TaskWriter`: `created` — строки до запроса не было; `assigned` — исполнитель теперь человек и не тот, что был. Личные задачи, правки текста, повтор, «снова для всех», отказанные и удалённые молчат.
- `LogWriter`: `done` — отметка стала выполненной (раньше не было или было невыполненной), сравнение по `(задача, день)`; одно событие на задачу за вызов (`select distinct`). Отметка за новый день после выполненного старого — тоже `done`. Личные задачи молчат.
- `SyncPushService` пока события **не собирает** — это B7.7.

### Сборка: уведомления после `push` (B7.7)

[src/push/push.service.ts](src/push/push.service.ts) (`PushService.notify`) и [src/sync/sync-push.service.ts](src/sync/sync-push.service.ts).

- В `SyncPushService.push` заводится один массив `events`, его получают `TaskWriter` и `LogWriter` внутри транзакции. После коммита (и после звонка по сокету) события, кроме относящихся к задачам, которые **этот же push** удаляет (и удаление не отказано), отдаются в `notify`.
- `notify` **не ждёт**: запускает фоновую работу и возвращается; нет ключа или нет событий — ни одного запроса. Работа: один SQL `WORLD` (живые группы + действующие участники, имена, токены телефонов участников) → `planPush` → отправка по 10 штук одновременно → один `delete` мёртвых токенов (только `unregistered`).
- Любая ошибка — строка в логе без токена, на запись не влияет. `idle()` дожидается начатого (тесты, остановка).
- Два слоя защиты от уведомления вышедшему: список участников в `WORLD` и выборка токенов оба смотрят только на `deleted_at is null`.

### WebSocket: подключение, `ping`/`pong`, звонок (B6.1–B6.5)

- [src/realtime/realtime.gateway.ts](src/realtime/realtime.gateway.ts) — шлюз `/ws` на чистом `ws` (адаптер `WsAdapter` подключается в [src/app.setup.ts](src/app.setup.ts), `configureWebSocket`, и в `main.ts`, и в тестовом приложении). Токен берётся из `?token=` и проверяется **только подписью** (`TokenService.verifyAccessToken`, без базы); плохой, просроченный или отсутствующий → закрытие кодом `4401`. `{"t":"ping"}` → `{"t":"pong"}`; всё остальное молча игнорируется. При подключении сервер ничего не присылает. Сообщение больше 1 КБ `ws` сам обрывает кодом `1009`. Другой путь, кроме `/ws`, отвергается. Адрес запроса нигде не пишется в лог (в нём токен).
- [src/realtime/realtime.service.ts](src/realtime/realtime.service.ts) — реестр «пользователь → подключения → время последнего сообщения» в памяти одного процесса. Не больше 10 подключений на пользователя: 11-е закрывает самое старое кодом `1008`. Раз в 5 минут таймер (`unref`, гасится в `onModuleDestroy`) вызывает `closeIdle()`: молчавшие дольше 10 минут закрываются кодом `1001`. Таймер базу не трогает; для тестов `closeIdle(now)` вызывается напрямую.
- Звонок (B6.2): `RealtimeService.ring(userIds, exceptDevice?)` шлёт `{"t":"changed"}` всем подключениям названных пользователей, кроме тех, чьё `device` равно `exceptDevice`. Подключение называет себя в `?device=`, запрос — заголовком `X-Device-Id` (декоратор `@DeviceId()`, [src/realtime/device-id.ts](src/realtime/device-id.ts)); имя — 1–64 символа `A-Za-z0-9_-`, иначе считается, что имени нет, и звонок приходит и этому устройству. Срок токена хранится у подключения (`TokenService.readAccessToken` отдаёт `expiresAt`): при `ring` и при `ping` просроченное подключение закрывается кодом `4401` вместо отправки — без таймеров. Любой сбой отправки проглатывается (в лог — только текст ошибки). - Звонок после `push` (B6.3): [src/sync/sync-push.service.ts](src/sync/sync-push.service.ts), `ringAboutWrite`, **после** коммита транзакции (откат → звонка нет). Если записано хоть что-то (строка не среди `rejected`; `unknown_label` не отказ) — звонок другим устройствам автора (`ring([userId], deviceId)`). Если среди записанного есть задачи, отметки или удаления задач и подключён кто-то ещё — один запрос: группы этих задач, где автор сейчас участник (`is_group_member`), → действующие участники из подключённых → `ring(участники)` **без** имени устройства (оно принадлежит автору). Ошибка звонка не ломает `push`: пишется в лог.
- Звонок при группах и профиле (B6.4): [src/realtime/ringer.service.ts](src/realtime/ringer.service.ts), `Ringer.ringFrom(отправитель, deviceId, {groups, users, inSendersGroups})`. Звонит другим устройствам отправителя (имя устройства — только отправителя) и: участникам `groups` (один запрос, только из подключённых, нет подключённых — нет запроса), названным `users` (нужно тем, кого в группе уже нет: ушедшему, убранному, бывшим при удалении), участникам всех групп отправителя (`inSendersGroups`, для профиля). Вызывается из `GroupsService` (создание, переименование, вступление, выход, исключение, удаление) и `UsersService.updateProfile` **после** сохранения, только если что-то реально изменилось. Модули: `RealtimeModule` — реестр и `Ringer`, ничего не импортирует (его импортируют `Groups`, `Users`, `Sync`); `RealtimeGatewayModule` — шлюз `/ws`, импортирует `AuthModule`; подключается в `AppModule`.
- Сквозные тесты (B6.5): [test/realtime-scenarios.e2e-spec.ts](test/realtime-scenarios.e2e-spec.ts) и имитация приложения с сокетом [test/support/live-device.ts](test/support/live-device.ts) (поверх `Device` из `fake-device.ts`; общий клиент сокетов — [test/support/ws-client.ts](test/support/ws-client.ts)). Правила, которым она следует, — это то, что должно сделать настоящее приложение в A7: после каждого подключения один `pull`, на `changed` один синк, на `4401` новый токен и новое подключение.
- Отказ по токену: `RealtimeService.refuse(socket)` шлёт `{"t":"unauthorized"}` **и** закрывает кодом `4401`. Причина: через прокси Render закрытие, начатое сервером, до клиента не доходит (клиент видит `1006` через ~20 с), а обычные сообщения доходят (измерено при B6.6). Телефон действует по сообщению. Используется при подключении с плохим токеном и лениво (при `ping` и звонке).
- Коды закрытия: `4401` токен, `1008` вытеснено 11-м подключением, `1001` молчал больше 10 минут, `1009` сообщение больше 1 КБ (все в контракте 4.5; на Render код не доходит).
- Тесты: [test/realtime.e2e-spec.ts](test/realtime.e2e-spec.ts) — настоящие подключения клиентом `ws` к слушающему приложению; в том числе «ни одного запроса к пулу базы» (шпион на `pool.connect`/`pool.query` с контрольным запросом, чтобы шпион не был слепым).
- Пакеты: `@nestjs/websockets` и `@nestjs/platform-ws` строго **11.2.7** (последние 12.x — только ESM и требуют Nest 12), `ws` 8, `@types/ws`.

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
| `tasks`, `diary`, `sync` | B2 ✅, B3 ✅ | таблицы и `pull` / `push` для личных задач, отметок и дневника; цикл (B4) добавится в те же маршруты |
| `groups` | B5 (B5.1 — таблицы) | группы, участники, коды приглашения, права |
| `devices` | B7 (B7.2–B7.3) | токены FCM телефонов, `PUT`/`DELETE /devices` |
| `push` | B7 (B7.4–B7.5) | отправка в FCM и правила «кому что»; события писателей (B7.6), сборка после `push` (B7.7) |
| `realtime` | B6 (B6.1 — подключение, `ping`/`pong`) | WebSocket-шлюз `/ws`; звонок `ring` готов (B6.2), вызывается из `push` (B6.3), групп и профиля (B6.4) |
| `push` | B7 | устройства, отправка через FCM |

## Решения, которые определяют форму кода

- Сервер подстраивается под приложение: ключи строк = ключи из `reference/payload.dart.txt`.
- Конфликты решает клиент при pull; сервер — «последний пришедший запрос побеждает».
- Права (бывший RLS Supabase) — проверки в коде; на каждое правило тест.
- Два штампа: `updated_at` (сервер, триггер) и `client_updated_at` (устройство).
