# FlowTest

FlowTest is a configuration-driven E2E runner for internal web applications. Playwright owns the browser lifecycle and evidence collection, Page-agent can perform natural-language interactions, and deterministic DOM, URL, or HTTP assertions decide whether a case passes.

The repository currently implements the phase-0 vertical slice from [`docs/PROJECT_PLAN.md`](docs/PROJECT_PLAN.md): a TypeScript/pnpm workspace, YAML validation, a CLI, browser execution, safety allowlists, setup/cleanup HTTP actions, artifacts, and a local smoke flow.

## Requirements

- Node.js 22 or newer
- pnpm 10
- Windows 11+, macOS 14+, or a Playwright-supported Linux distribution

## Quick start

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm build
```

Start the safe local demo application in one terminal:

```bash
pnpm demo:server
```

Then validate and run the example case in another terminal:

```bash
pnpm flowtest validate cases/smoke/local-order.yaml --env test
pnpm flowtest run cases/smoke/local-order.yaml --env test
```

Every run writes `report.html`, `report.json`, `junit.xml`, console/network logs, and configured browser evidence under `artifacts/run-*/`.

## Workspace layout

- `apps/cli/` — `validate`, `run`, and `list` commands.
- `packages/config-schema/` — Zod schema, YAML loading, variables, and URL allowlists.
- `packages/runner-core/` — setup, stages, assertions, cleanup, and error classification.
- `packages/playwright-adapter/` — browser isolation, tracing, screenshots, and logs.
- `packages/page-agent-adapter/` — browser bundle injection and Agent execution.
- `packages/assertion-kit/` — URL, visibility, text, HTTP, and export assertions.
- `packages/reporters/` — HTML, JSON, and JUnit output with secret redaction.
- `cases/` and `environments/` — business flows and environment overlays.

## Development

```bash
pnpm build
pnpm lint
pnpm test
```

The E2E test starts an ephemeral local application and verifies order creation, five strong assertions, reporting, and cleanup with a real headless Chromium process.

## Page-agent configuration

Agent stages require an OpenAI-compatible endpoint with Tool Calling support. Set `LLM_BASE_URL`, `LLM_MODEL_NAME`, and optionally `LLM_API_KEY`; never commit these values. `pnpm build` generates the injected browser bundle. The included local case uses deterministic Playwright actions so contributors can verify the Runner without sending data to an external model.
