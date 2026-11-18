# Repository Guidelines

## Project Structure & Module Organization

This is a NestJS 11 API using TypeORM and PostgreSQL. Feature modules live in
`src/<feature>/` (for example, `auth/`, `sync/`, `groups/`, and `tasks/`) and
typically contain their module, controller, service, DTOs, entities, and
colocated unit tests (`*.spec.ts`). Shared infrastructure belongs in `src/common/`,
configuration in `src/config/`, and database setup in `src/database/`.

Schema changes are append-only TypeORM migrations in `src/migrations/`. Put
application-level end-to-end tests in `test/` as `*.e2e-spec.ts`; reusable test
helpers belong in `test/support/`. Operational scripts are in `scripts/`, while
deployment artifacts are in `deploy/`.

## Build, Test, and Development Commands

- `npm ci` installs the locked Node.js dependencies (Node 22).
- `npm run start:dev` starts the API with file watching; `npm run build` writes
  production output to `dist/`.
- `npm run lint` runs ESLint with `--fix`, so review its edits; `npm run format`
  runs Prettier over `src/` and `test/`.
- `npm test` runs unit tests. `npm run test:cov` adds coverage output.
- `npm run test:db:up`, then `npm run test:e2e`, runs integration tests against
  the Docker PostgreSQL test database. Finish with `npm run test:db:down`.
- After building, use `npm run migration:run` to apply migrations. Check status
  first with `npm run migration:show`.

## Coding Style & Naming Conventions

Write TypeScript with the existing NestJS dependency-injection pattern. Prettier
controls formatting; do not hand-format around it. Use `PascalCase` for classes,
`camelCase` for TypeScript members, `kebab-case` filenames such as
`sync-push.service.ts`, and `*.dto.ts`, `*.entity.ts`, or `*.module.ts` suffixes.
The external API and database columns use `snake_case` (apart from documented
authentication response fields). Validate DTO inputs and never accept `user_id`
from a client when it must come from authentication.

## Testing Guidelines

Use Jest and `ts-jest`. Add focused `*.spec.ts` tests alongside changed source;
add `*.e2e-spec.ts` coverage for HTTP, WebSocket, database, access-control, or
sync behavior. E2E tests erase their dedicated local test database only—never
point `TEST_DATABASE_URL` at a shared or production database. Before requesting
review, run `npm run build`, `npm test`, `npm run test:e2e`, and `npm run lint`.

## Commits, Pull Requests, and Security

Recent history uses short imperative subjects such as `Add projects API` and
`Harden the server (B8)`; follow that style and keep commits narrowly scoped.
PRs should state the behavioral change, tests run, migration/configuration
requirements, and link the relevant issue. Include request/response examples
for API changes. Do not commit `.env`, `JWT_SECRET`, database URLs, Firebase
credentials, or other secrets. Describe new environment variables in
`.env.example` and `README.md`.

## Rules

- Use the nestjs-best-practices skill.
