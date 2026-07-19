import type { Page } from "playwright";

import {
  ensureAllowedUrl,
  patternFromString,
  renderValue,
  type AssertionConfig,
  type HttpRequestConfig,
  type RuntimeContext,
} from "@flowtest/config-schema";

export class AssertionFailure extends Error {
  readonly code = "ASSERTION_FAILED";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AssertionFailure";
  }
}

export interface HttpExecutionResult {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export interface AssertionResult {
  type: AssertionConfig["type"];
  message: string;
}

export function getJsonPath(value: unknown, jsonPath: string): unknown {
  if (!jsonPath.startsWith("$.")) {
    throw new AssertionFailure(
      `Only simple JSON paths beginning with $. are supported: ${jsonPath}`,
    );
  }
  return jsonPath
    .slice(2)
    .split(".")
    .reduce<unknown>((current, segment) => {
      if (
        typeof current !== "object" ||
        current === null ||
        !(segment in current)
      ) {
        throw new AssertionFailure(`JSON path not found: ${jsonPath}`);
      }
      return (current as Record<string, unknown>)[segment];
    }, value);
}

export async function executeHttpRequest(
  requestTemplate: HttpRequestConfig,
  context: RuntimeContext,
  allowedHosts: readonly string[],
): Promise<HttpExecutionResult> {
  const request = renderValue(requestTemplate, context);
  const url = ensureAllowedUrl(String(request.url), allowedHosts);
  const headers: Record<string, string> = { ...request.headers };
  let body: BodyInit | undefined;

  if (request.body !== undefined) {
    if (typeof request.body === "string") {
      body = request.body;
    } else {
      body = JSON.stringify(request.body);
      const hasContentType = Object.keys(headers).some(
        (key) => key.toLowerCase() === "content-type",
      );
      if (!hasContentType) {
        headers["content-type"] = "application/json";
      }
    }
  }

  const response = await fetch(url, {
    method: request.method,
    headers,
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(30_000),
  });
  const responseText = await response.text();
  let responseBody: unknown = responseText;
  if (responseText.length > 0) {
    try {
      responseBody = JSON.parse(responseText) as unknown;
    } catch {
      // Keep non-JSON responses as text.
    }
  }

  return {
    status: response.status,
    body: responseBody,
    headers: Object.fromEntries(response.headers.entries()),
  };
}

function valuesEqual(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) {
    return true;
  }
  if (typeof actual === "object" && typeof expected === "object") {
    return JSON.stringify(actual) === JSON.stringify(expected);
  }
  return false;
}

export async function executeAssertion(
  page: Page,
  assertionTemplate: AssertionConfig,
  context: RuntimeContext,
  allowedHosts: readonly string[],
): Promise<AssertionResult> {
  const assertion = renderValue(assertionTemplate, context);

  switch (assertion.type) {
    case "url": {
      const pattern = patternFromString(assertion.matches);
      if (!pattern.test(page.url())) {
        throw new AssertionFailure(
          `URL ${page.url()} does not match ${assertion.matches}`,
        );
      }
      return {
        type: assertion.type,
        message: `URL matched ${assertion.matches}`,
      };
    }

    case "visible": {
      const locator = page.locator(assertion.locator).first();
      await locator.waitFor({ state: "visible" });
      return {
        type: assertion.type,
        message: `${assertion.locator} is visible`,
      };
    }

    case "text": {
      const actual =
        (await page.locator(assertion.locator).first().textContent())?.trim() ??
        "";
      if (
        assertion.equals !== undefined &&
        actual !== String(assertion.equals)
      ) {
        throw new AssertionFailure(
          `${assertion.locator} text was ${JSON.stringify(actual)}, expected ${JSON.stringify(String(assertion.equals))}`,
        );
      }
      if (
        assertion.contains !== undefined &&
        !actual.includes(assertion.contains)
      ) {
        throw new AssertionFailure(
          `${assertion.locator} text did not contain ${JSON.stringify(assertion.contains)}`,
        );
      }
      return {
        type: assertion.type,
        message: `${assertion.locator} text matched`,
      };
    }

    case "http": {
      const response = await executeHttpRequest(
        assertion.request,
        context,
        allowedHosts,
      );
      if (response.status !== assertion.expect.status) {
        throw new AssertionFailure(
          `HTTP status was ${response.status}, expected ${assertion.expect.status}`,
        );
      }
      for (const [jsonPath, expected] of Object.entries(
        assertion.expect.json ?? {},
      )) {
        const actual = getJsonPath(response.body, jsonPath);
        if (!valuesEqual(actual, expected)) {
          throw new AssertionFailure(
            `${jsonPath} was ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
          );
        }
      }
      return {
        type: assertion.type,
        message: `HTTP response matched (${response.status})`,
      };
    }

    case "export": {
      const pattern = patternFromString(assertion.pattern);
      const match = pattern.exec(page.url());
      if (match?.[1] === undefined) {
        throw new AssertionFailure(
          `Unable to export ${assertion.name} from URL using ${assertion.pattern}`,
        );
      }
      context[assertion.name] = match[1];
      return { type: assertion.type, message: `Exported ${assertion.name}` };
    }
  }
}
