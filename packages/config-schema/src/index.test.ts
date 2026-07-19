import { describe, expect, it } from "vitest";

import { ConfigurationError, parseTestCaseYaml, renderValue } from "./index.js";

const validCase = `
apiVersion: flowtest.ai/v1
kind: TestCase
metadata:
  id: local-order
  name: Local order
environment:
  baseUrl: http://127.0.0.1:4173
  allowedHosts: [127.0.0.1]
browser: {}
safety:
  environmentAllowlist: [test]
stages:
  - id: create-order
    actions:
      - type: click
        locator: button
    assertions:
      - type: visible
        locator: main
`;

describe("parseTestCaseYaml", () => {
  it("applies safe defaults", () => {
    const config = parseTestCaseYaml(validCase);
    expect(config.browser.engine).toBe("chromium");
    expect(config.artifacts.trace).toBe("retain-on-failure");
  });

  it("rejects a stage without a deterministic assertion", () => {
    expect(() =>
      parseTestCaseYaml(validCase.replace("assertions:", "checks:")),
    ).toThrow(ConfigurationError);
  });
});

describe("renderValue", () => {
  it("preserves non-string values for exact tokens", () => {
    expect(renderValue("${quantity}", { quantity: 2 })).toBe(2);
    expect(renderValue("order-${RUN_ID}", { RUN_ID: "abc" })).toBe("order-abc");
  });
});
