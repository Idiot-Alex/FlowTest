#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import path from "node:path";

import { ConfigurationError, loadTestCase } from "@flowtest/config-schema";
import { runTestCase } from "@flowtest/runner-core";

const usage = `FlowTest

Usage:
  pnpm flowtest validate <case.yaml> [--env test]
  pnpm flowtest run <case.yaml> [--env test]
  pnpm flowtest list [directory]
`;

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new ConfigurationError(`${name} requires a value`);
  }
  return value;
}

async function listYamlFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return listYamlFiles(entryPath);
      }
      return /\.ya?ml$/i.test(entry.name) ? [entryPath] : [];
    }),
  );
  return nested.flat().sort();
}

async function main(): Promise<void> {
  const [command, target, ...rest] = process.argv.slice(2);
  if (command === undefined || ["-h", "--help", "help"].includes(command)) {
    console.log(usage);
    return;
  }

  if (command === "list") {
    const directory = path.resolve(target ?? "cases");
    const files = await listYamlFiles(directory);
    for (const file of files) {
      console.log(path.relative(process.cwd(), file));
    }
    return;
  }

  if (!["run", "validate"].includes(command) || target === undefined) {
    throw new ConfigurationError(`Invalid command\n\n${usage}`);
  }

  const environmentName = readFlag(rest, "--env") ?? "test";
  const casePath = path.resolve(target);
  const config = await loadTestCase(casePath, environmentName);

  if (!config.safety.environmentAllowlist.includes(environmentName)) {
    throw new ConfigurationError(
      `Environment is not allowlisted: ${environmentName}`,
    );
  }

  if (command === "validate") {
    console.log(`✓ ${config.metadata.id} is valid for ${environmentName}`);
    return;
  }

  const result = await runTestCase(config, { environmentName });
  const marker = result.report.status === "passed" ? "✓" : "✗";
  console.log(`${marker} ${result.report.caseId}: ${result.report.status}`);
  console.log(
    `Artifacts: ${path.relative(process.cwd(), result.artifactDirectory)}`,
  );
  if (result.report.error !== undefined) {
    console.error(
      `${result.report.error.code}: ${result.report.error.message}`,
    );
    process.exitCode = 1;
  }
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "INFRA_FAILURE";
  console.error(`${code}: ${message}`);
  process.exitCode = 1;
});
