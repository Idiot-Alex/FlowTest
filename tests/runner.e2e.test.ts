import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseTestCaseYaml } from "@flowtest/config-schema";
import { runTestCase } from "@flowtest/runner-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startDemoServer } from "../examples/local-app/server.js";

let demo: Awaited<ReturnType<typeof startDemoServer>> | undefined;

beforeAll(async () => {
  demo = await startDemoServer(0);
});

afterAll(async () => {
  await demo?.close();
});

describe("FlowTest runner", () => {
  it("runs a deterministic local business flow", async () => {
    if (demo === undefined) {
      throw new Error("Demo server did not start");
    }
    const source = await readFile(
      path.resolve("cases/smoke/local-order.yaml"),
      "utf8",
    );
    const parsed = parseTestCaseYaml(source);
    const config = {
      ...parsed,
      environment: {
        baseUrl: demo.baseUrl,
        allowedHosts: ["127.0.0.1"],
      },
      artifacts: {
        ...parsed.artifacts,
        screenshot: "off" as const,
        video: "off" as const,
        trace: "off" as const,
      },
    };

    const result = await runTestCase(config, {
      environmentName: "test",
      artifactRoot: path.resolve("artifacts/test-runs"),
    });

    expect(result.report.status).toBe("passed");
    expect(result.report.stages).toHaveLength(1);
    expect(result.report.stages[0]?.assertions).toHaveLength(5);
  });
});
