import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  executeAssertion,
  executeHttpRequest,
  getJsonPath,
} from "@flowtest/assertion-kit";
import {
  ensureAllowedUrl,
  renderValue,
  resolveVariables,
  type BrowserAction,
  type RuntimeContext,
  type StageConfig,
  type TestCaseConfig,
} from "@flowtest/config-schema";
import {
  AgentExecutionError,
  executePageAgentTask,
  installPageAgentBundle,
  type PageAgentExecutionResult,
} from "@flowtest/page-agent-adapter";
import {
  createBrowserSession,
  type BrowserSession,
} from "@flowtest/playwright-adapter";
import {
  writeReports,
  type RunReport,
  type StageReport,
} from "@flowtest/reporters";
import type { Locator, Page } from "playwright";

export interface RunOptions {
  environmentName: string;
  artifactRoot?: string;
  pageAgentBundlePath?: string;
}

export interface RunResult {
  artifactDirectory: string;
  report: RunReport;
}

interface ClassifiedError {
  code: string;
  message: string;
}

function classifyError(error: unknown): ClassifiedError {
  if (typeof error === "object" && error !== null) {
    const candidate = error as {
      code?: unknown;
      message?: unknown;
      name?: unknown;
    };
    if (
      typeof candidate.code === "string" &&
      typeof candidate.message === "string"
    ) {
      return { code: candidate.code, message: candidate.message };
    }
    if (typeof candidate.message === "string") {
      const code =
        candidate.name === "TimeoutError" ? "INFRA_FAILURE" : "INFRA_FAILURE";
      return { code, message: candidate.message };
    }
  }
  return { code: "INFRA_FAILURE", message: String(error) };
}

function createRunId(): string {
  const timestamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, "");
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

async function assertActionAllowed(
  locator: Locator,
  locatorSource: string,
  blockedSelectors: readonly string[],
): Promise<void> {
  if (blockedSelectors.includes(locatorSource)) {
    throw new AgentExecutionError(
      `Action is blocked by safety policy: ${locatorSource}`,
    );
  }
  const isBlocked = await locator.evaluate(
    (element, selectors) =>
      selectors.some(
        (selector) =>
          element.matches(selector) || element.closest(selector) !== null,
      ),
    blockedSelectors,
  );
  if (isBlocked) {
    throw new AgentExecutionError(
      `Target is inside a blocked element: ${locatorSource}`,
    );
  }
}

async function executeBrowserAction(
  page: Page,
  actionTemplate: BrowserAction,
  context: RuntimeContext,
  blockedSelectors: readonly string[],
): Promise<void> {
  const action = renderValue(actionTemplate, context);
  const locator = page.locator(action.locator).first();
  await assertActionAllowed(locator, action.locator, blockedSelectors);

  switch (action.type) {
    case "fill":
      await locator.fill(String(action.value));
      break;
    case "click":
      await locator.click();
      break;
    case "select":
      await locator
        .selectOption({ label: action.value })
        .catch(async () => locator.selectOption(action.value));
      break;
  }
}

async function executeSetupAction(
  action: TestCaseConfig["setup"][number],
  context: RuntimeContext,
  allowedHosts: readonly string[],
): Promise<void> {
  const response = await executeHttpRequest(
    action.request,
    context,
    allowedHosts,
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Setup HTTP action ${action.id ?? "unnamed"} returned ${response.status}`,
    );
  }
  for (const [name, jsonPath] of Object.entries(action.export ?? {})) {
    context[name] = getJsonPath(response.body, jsonPath);
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function executeStage(
  page: Page,
  stage: StageConfig,
  config: TestCaseConfig,
  context: RuntimeContext,
  allowedHosts: readonly string[],
  baseUrl: string,
): Promise<StageReport> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const assertionReports: StageReport["assertions"] = [];
  let agentResult: PageAgentExecutionResult | undefined;

  const run = async (): Promise<void> => {
    const timeoutMs = stage.timeoutMs ?? config.browser.timeoutMs;
    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(timeoutMs);

    if (stage.url !== undefined) {
      const stageUrl = new URL(
        String(renderValue(stage.url, context)),
        baseUrl,
      ).toString();
      ensureAllowedUrl(stageUrl, allowedHosts);
      await page.goto(stageUrl, { waitUntil: stage.waitUntil });
    }

    for (const action of stage.actions) {
      await executeBrowserAction(
        page,
        action,
        context,
        config.safety.blockedSelectors,
      );
    }

    if (stage.agent !== undefined) {
      const baseURL = process.env.LLM_BASE_URL;
      const model = process.env.LLM_MODEL_NAME;
      if (baseURL === undefined || model === undefined) {
        throw new AgentExecutionError(
          "Agent stage requires LLM_BASE_URL and LLM_MODEL_NAME environment variables",
        );
      }
      agentResult = await executePageAgentTask(page, {
        task: String(renderValue(stage.agent.task, context)),
        instructions: renderValue(stage.agent.instructions, context),
        baseURL,
        model,
        ...(process.env.LLM_API_KEY === undefined
          ? {}
          : { apiKey: process.env.LLM_API_KEY }),
        language: config.browser.locale,
        blockedSelectors: config.safety.blockedSelectors,
        maxSteps: config.safety.maxAgentStepsPerStage,
      });
    }

    for (const assertion of stage.assertions) {
      assertionReports.push(
        await executeAssertion(page, assertion, context, allowedHosts),
      );
    }
  };

  try {
    await withTimeout(
      run(),
      stage.timeoutMs ?? config.browser.timeoutMs,
      `Stage ${stage.id}`,
    );
    const finished = Date.now();
    return {
      id: stage.id,
      status: "passed",
      startedAt,
      finishedAt: new Date(finished).toISOString(),
      durationMs: finished - started,
      assertions: assertionReports,
      ...(agentResult === undefined ? {} : { agent: agentResult }),
    };
  } catch (error) {
    const finished = Date.now();
    const classified = classifyError(error);
    return {
      id: stage.id,
      status: "failed",
      startedAt,
      finishedAt: new Date(finished).toISOString(),
      durationMs: finished - started,
      assertions: assertionReports,
      ...(agentResult === undefined ? {} : { agent: agentResult }),
      error: classified,
    };
  }
}

function secretValues(): string[] {
  return Object.entries(process.env)
    .filter(
      ([key, value]) =>
        value !== undefined && /(TOKEN|KEY|SECRET|PASSWORD)/i.test(key),
    )
    .map(([, value]) => value)
    .filter((value): value is string => value !== undefined);
}

function missingTemplateValues(
  value: unknown,
  context: RuntimeContext,
): string[] {
  const source = JSON.stringify(value);
  return [...source.matchAll(/\$\{([^}]+)}/g)]
    .map((match) => match[1])
    .filter((token): token is string => token !== undefined)
    .filter((token) => {
      const key = token.startsWith("secret:")
        ? token.slice("secret:".length)
        : token;
      return context[key] === undefined && process.env[key] === undefined;
    });
}

export async function runTestCase(
  config: TestCaseConfig,
  options: RunOptions,
): Promise<RunResult> {
  const runId = createRunId();
  const artifactRoot = path.resolve(options.artifactRoot ?? "artifacts");
  const artifactDirectory = path.join(
    artifactRoot,
    `run-${runId}-${config.metadata.id}`,
  );
  const started = Date.now();
  const context: RuntimeContext = { ...process.env, RUN_ID: runId };
  const stageReports: StageReport[] = [];
  const cleanupReport: RunReport["cleanup"] = { status: "skipped", errors: [] };
  let session: BrowserSession | undefined;
  let runError: ClassifiedError | undefined;

  if (!config.safety.environmentAllowlist.includes(options.environmentName)) {
    runError = {
      code: "CONFIG_INVALID",
      message: `Environment is not allowlisted: ${options.environmentName}`,
    };
  }

  const allowedHosts = renderValue(
    config.environment.allowedHosts,
    context,
  ).map(String);
  const baseUrl = String(renderValue(config.environment.baseUrl, context));
  if (runError === undefined) {
    ensureAllowedUrl(baseUrl, allowedHosts);
    context.BASE_URL = baseUrl;
    Object.assign(context, resolveVariables(config.variables, context));
  }

  try {
    if (runError !== undefined) {
      throw Object.assign(new Error(runError.message), { code: runError.code });
    }

    for (const action of config.setup) {
      await executeSetupAction(action, context, allowedHosts);
    }

    const browserConfig = renderValue(config.browser, context);
    session = await createBrowserSession(
      browserConfig,
      config.artifacts,
      artifactDirectory,
      allowedHosts,
    );

    if (config.stages.some((stage) => stage.agent !== undefined)) {
      const bundlePath = path.resolve(
        options.pageAgentBundlePath ??
          "packages/page-agent-adapter/dist/page-agent.iife.js",
      );
      await installPageAgentBundle(session.context, bundlePath);
    }

    for (const stage of config.stages) {
      const stageReport = await executeStage(
        session.page,
        stage,
        config,
        context,
        allowedHosts,
        baseUrl,
      );
      stageReports.push(stageReport);
      if (stageReport.status === "failed") {
        runError = stageReport.error ?? {
          code: "INFRA_FAILURE",
          message: `Stage failed: ${stage.id}`,
        };
        break;
      }
    }
  } catch (error) {
    runError = classifyError(error);
  } finally {
    if (config.cleanup.always || runError === undefined) {
      let cleanupActionsRun = 0;
      for (const action of config.cleanup.actions) {
        if (missingTemplateValues(action, context).length > 0) {
          continue;
        }
        cleanupActionsRun += 1;
        try {
          await executeSetupAction(action, context, allowedHosts);
        } catch (error) {
          cleanupReport.status = "failed";
          cleanupReport.errors.push(classifyError(error).message);
        }
      }
      if (cleanupReport.status !== "failed") {
        cleanupReport.status = cleanupActionsRun === 0 ? "skipped" : "passed";
      }
    }

    if (session !== undefined) {
      try {
        await session.finalize(runError === undefined);
      } catch (error) {
        runError ??= classifyError(error);
      }
    }
  }

  if (cleanupReport.status === "failed" && runError === undefined) {
    runError = {
      code: "CLEANUP_FAILED",
      message: cleanupReport.errors.join("; "),
    };
  }

  const finished = Date.now();
  const report: RunReport = {
    runId,
    caseId: config.metadata.id,
    caseName: config.metadata.name,
    environment: options.environmentName,
    status: runError === undefined ? "passed" : "failed",
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    stages: stageReports,
    cleanup: cleanupReport,
    ...(runError === undefined ? {} : { error: runError }),
  };
  await writeReports(report, artifactDirectory, secretValues());
  return { artifactDirectory, report };
}
