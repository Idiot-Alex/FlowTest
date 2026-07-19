# Repository Guidelines

## Project Structure & Module Organization

FlowTest is currently in the planning phase; its blueprint is `docs/PROJECT_PLAN.md`. The planned TypeScript/pnpm monorepo places the CLI in `apps/cli/`, reusable components in `packages/` (for example, `runner-core` and `assertion-kit`), YAML scenarios in `cases/{smoke,regression}/`, and environment definitions in `environments/`. Keep generated reports and browser evidence under ignored `artifacts/`. Never commit authentication state from `auth/`.

## Build, Test, and Development Commands

No executable package scripts exist yet. When scaffolding the repository, expose these operations as root pnpm scripts and use the same commands in CI:

- `pnpm install --frozen-lockfile` installs the exact workspace dependencies.
- `pnpm build` compiles all applications and packages.
- `pnpm lint` runs formatting and static checks.
- `pnpm test` runs unit and integration tests.
- `pnpm exec playwright install chromium` installs the E2E browser.
- `pnpm flowtest validate cases/order-approval.yaml` validates a scenario.
- `pnpm flowtest run cases/order-approval.yaml --env staging` runs it locally.

## Coding Style & Naming Conventions

Use TypeScript with two-space indentation, semicolons, and explicit types at package boundaries. Add Prettier and ESLint configurations with the first source code. Name files and directories in kebab-case, variables/functions in camelCase, and types/classes in PascalCase. Give cases stable IDs such as `order-approval-happy-path`. AI may choose interactions; deterministic code must decide pass or failure.

## Testing Guidelines

Place unit tests beside source files as `*.test.ts`; reserve `cases/` for YAML flows. Independently test parsing, runner states, assertions, cleanup, and secret redaction. Playwright scenarios must use event- or state-based waits, never fixed sleeps. Before making a smoke test blocking, run it 20 times, require 95% success, and confirm strong assertions catch injected failures.

## Commit & Pull Request Guidelines

With only one initial commit, no reliable convention exists. Use short, imperative, scoped Conventional Commits such as `feat(runner): add stage timeout handling`. Keep commits focused. Pull requests should explain intent, list verification commands, link an issue or plan section, and include screenshots or report excerpts for visible changes. Explicitly call out configuration or security impacts.

## Security & Configuration

Read credentials only from environment variables or an approved secret provider. Restrict runs to declared test/staging hosts, mock external side effects, redact cookies and authorization data from reports, and never target production by default.
