import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

const headersSchema = z.record(z.string(), z.string()).default({});

export const httpRequestSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
  url: z.string().min(1),
  headers: headersSchema,
  body: z.unknown().optional(),
});

const setupActionSchema = z.object({
  id: z.string().min(1).optional(),
  type: z.literal("http"),
  request: httpRequestSchema,
  export: z.record(z.string(), z.string()).optional(),
});

export const browserActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("fill"),
    locator: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean()]),
  }),
  z.object({
    type: z.literal("click"),
    locator: z.string().min(1),
  }),
  z.object({
    type: z.literal("select"),
    locator: z.string().min(1),
    value: z.string().min(1),
  }),
]);

const urlAssertionSchema = z.object({
  type: z.literal("url"),
  matches: z.string().min(1),
});

const visibleAssertionSchema = z.object({
  type: z.literal("visible"),
  locator: z.string().min(1),
});

const textAssertionSchema = z
  .object({
    type: z.literal("text"),
    locator: z.string().min(1),
    equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
    contains: z.string().optional(),
  })
  .refine(
    (value) => value.equals !== undefined || value.contains !== undefined,
    {
      message: "text assertion requires equals or contains",
    },
  );

const httpAssertionSchema = z.object({
  type: z.literal("http"),
  request: httpRequestSchema,
  expect: z.object({
    status: z.number().int().min(100).max(599),
    json: z.record(z.string(), z.unknown()).optional(),
  }),
});

const exportAssertionSchema = z.object({
  type: z.literal("export"),
  name: z.string().min(1),
  from: z.literal("url"),
  pattern: z.string().min(1),
});

export const assertionSchema = z.union([
  urlAssertionSchema,
  visibleAssertionSchema,
  textAssertionSchema,
  httpAssertionSchema,
  exportAssertionSchema,
]);

const stageSchema = z
  .object({
    id: z.string().min(1),
    url: z.string().min(1).optional(),
    waitUntil: z
      .enum(["commit", "domcontentloaded", "load", "networkidle"])
      .default("domcontentloaded"),
    timeoutMs: z.number().int().positive().optional(),
    actions: z.array(browserActionSchema).default([]),
    agent: z
      .object({
        task: z.string().min(1),
        instructions: z.array(z.string()).default([]),
        expectedNavigation: z.string().optional(),
      })
      .optional(),
    assertions: z.array(assertionSchema).min(1),
  })
  .refine((stage) => stage.actions.length > 0 || stage.agent !== undefined, {
    message: "stage requires deterministic actions or an agent task",
  });

const artifactModeSchema = z.enum([
  "off",
  "always",
  "on-failure",
  "retain-on-failure",
]);

export const testCaseSchema = z.object({
  apiVersion: z.literal("flowtest.ai/v1"),
  kind: z.literal("TestCase"),
  metadata: z.object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().min(1),
    tags: z.array(z.string()).default([]),
    owner: z.string().min(1).optional(),
  }),
  environment: z.object({
    baseUrl: z.string().min(1),
    allowedHosts: z.array(z.string().min(1)).min(1),
  }),
  browser: z.object({
    engine: z.literal("chromium").default("chromium"),
    headless: z.boolean().default(true),
    locale: z.string().default("zh-CN"),
    viewport: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .default({ width: 1440, height: 900 }),
    storageState: z.string().optional(),
    timeoutMs: z.number().int().positive().default(30_000),
  }),
  variables: z.record(z.string(), z.unknown()).default({}),
  safety: z.object({
    environmentAllowlist: z.array(z.string()).min(1),
    blockedSelectors: z.array(z.string()).default([]),
    maxAgentStepsPerStage: z.number().int().positive().default(12),
    maxModelCallsPerCase: z.number().int().positive().default(30),
  }),
  setup: z.array(setupActionSchema).default([]),
  stages: z.array(stageSchema).min(1),
  cleanup: z
    .object({
      always: z.boolean().default(true),
      actions: z.array(setupActionSchema).default([]),
    })
    .default({ always: true, actions: [] }),
  artifacts: z
    .object({
      screenshot: artifactModeSchema.default("on-failure"),
      video: artifactModeSchema.default("retain-on-failure"),
      trace: artifactModeSchema.default("retain-on-failure"),
      console: z.boolean().default(true),
      network: z.enum(["off", "all", "failures-only"]).default("failures-only"),
    })
    .default({
      screenshot: "on-failure",
      video: "retain-on-failure",
      trace: "retain-on-failure",
      console: true,
      network: "failures-only",
    }),
  retry: z
    .object({
      caseRetries: z.number().int().min(0).default(0),
      stageRetries: z.number().int().min(0).default(0),
      retryOn: z.array(z.string()).default([]),
    })
    .default({ caseRetries: 0, stageRetries: 0, retryOn: [] }),
});

export type HttpRequestConfig = z.infer<typeof httpRequestSchema>;
export type BrowserAction = z.infer<typeof browserActionSchema>;
export type AssertionConfig = z.infer<typeof assertionSchema>;
export type TestCaseConfig = z.infer<typeof testCaseSchema>;
export type StageConfig = TestCaseConfig["stages"][number];
export type RuntimeContext = Record<string, unknown>;

export class ConfigurationError extends Error {
  readonly code = "CONFIG_INVALID";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigurationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
    .join("\n");
}

export function parseTestCase(value: unknown): TestCaseConfig {
  const result = testCaseSchema.safeParse(value);
  if (!result.success) {
    throw new ConfigurationError(formatIssues(result.error), {
      cause: result.error,
    });
  }
  return result.data;
}

export function parseTestCaseYaml(source: string): TestCaseConfig {
  try {
    return parseTestCase(parseYaml(source));
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw new ConfigurationError("Unable to parse YAML configuration", {
      cause: error,
    });
  }
}

export async function loadTestCase(
  filePath: string,
  environmentName?: string,
): Promise<TestCaseConfig> {
  const source = await readFile(filePath, "utf8");
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (error) {
    throw new ConfigurationError(`Unable to parse ${filePath}`, {
      cause: error,
    });
  }

  if (environmentName !== undefined) {
    const environmentPath = path.resolve(
      process.cwd(),
      "environments",
      `${environmentName}.yaml`,
    );
    const environmentSource = await readFile(environmentPath, "utf8").catch(
      (error: unknown) => {
        throw new ConfigurationError(
          `Unable to read environment file ${environmentPath}`,
          { cause: error },
        );
      },
    );
    const environmentRaw: unknown = parseYaml(environmentSource);
    if (!isRecord(raw) || !isRecord(environmentRaw)) {
      throw new ConfigurationError(
        "Test case and environment files must contain YAML objects",
      );
    }
    const existingEnvironment = isRecord(raw.environment)
      ? raw.environment
      : {};
    raw = {
      ...raw,
      environment: {
        ...existingEnvironment,
        ...environmentRaw,
      },
    };
  }

  return parseTestCase(raw);
}

const exactTokenPattern = /^\$\{([^}]+)}$/;
const tokenPattern = /\$\{([^}]+)}/g;

function lookupToken(token: string, context: RuntimeContext): unknown {
  if (token.startsWith("secret:")) {
    return process.env[token.slice("secret:".length)];
  }
  return context[token] ?? process.env[token];
}

export function renderValue<T>(
  value: T,
  context: RuntimeContext,
  strict = true,
): T {
  if (typeof value === "string") {
    const exactMatch = exactTokenPattern.exec(value);
    if (exactMatch !== null) {
      const token = exactMatch[1];
      if (token === undefined) {
        return value;
      }
      const replacement = lookupToken(token, context);
      if (replacement === undefined) {
        if (strict) {
          throw new ConfigurationError(`Missing value for ${"${"}${token}}`);
        }
        return value;
      }
      return replacement as T;
    }

    return value.replace(tokenPattern, (match, token: string) => {
      const replacement = lookupToken(token, context);
      if (replacement === undefined) {
        if (strict) {
          throw new ConfigurationError(`Missing value for ${"${"}${token}}`);
        }
        return match;
      }
      return String(replacement);
    }) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => renderValue(item, context, strict)) as T;
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        renderValue(item, context, strict),
      ]),
    ) as T;
  }

  return value;
}

export function resolveVariables(
  variables: Record<string, unknown>,
  seed: RuntimeContext,
): RuntimeContext {
  const context: RuntimeContext = { ...seed };
  for (let pass = 0; pass <= Object.keys(variables).length; pass += 1) {
    for (const [key, value] of Object.entries(variables)) {
      context[key] = renderValue(value, context, false);
    }
  }
  return Object.fromEntries(
    Object.keys(variables).map((key) => [key, context[key]]),
  );
}

export function ensureAllowedUrl(
  url: string,
  allowedHosts: readonly string[],
): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new ConfigurationError(`Invalid absolute URL: ${url}`, {
      cause: error,
    });
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new ConfigurationError(
      `Unsupported URL protocol: ${parsed.protocol}`,
    );
  }
  if (!allowedHosts.includes(parsed.hostname)) {
    throw new ConfigurationError(`Host is not allowlisted: ${parsed.hostname}`);
  }
  return parsed;
}

export function patternFromString(source: string): RegExp {
  const delimited = /^\/(.*)\/([dgimsuvy]*)$/.exec(source);
  try {
    return delimited === null
      ? new RegExp(source)
      : new RegExp(delimited[1] ?? "", delimited[2] ?? "");
  } catch (error) {
    throw new ConfigurationError(`Invalid regular expression: ${source}`, {
      cause: error,
    });
  }
}
