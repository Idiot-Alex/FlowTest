import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface StageReport {
  id: string;
  status: "passed" | "failed";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  assertions: Array<{ type: string; message: string }>;
  agent?: { success: boolean; data: unknown; history: unknown };
  error?: { code: string; message: string };
}

export interface RunReport {
  runId: string;
  caseId: string;
  caseName: string;
  environment: string;
  status: "passed" | "failed";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stages: StageReport[];
  cleanup: { status: "passed" | "failed" | "skipped"; errors: string[] };
  error?: { code: string; message: string };
}

function redactString(value: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length >= 4)
    .reduce(
      (redacted, secret) => redacted.replaceAll(secret, "[REDACTED]"),
      value,
    );
}

function redact(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return redactString(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, secrets));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redact(item, secrets)]),
    );
  }
  return value;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function createJunit(report: RunReport): string {
  const failure =
    report.error === undefined
      ? ""
      : `<failure type="${escapeXml(report.error.code)}" message="${escapeXml(report.error.message)}" />`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="FlowTest" tests="1" failures="${report.status === "failed" ? 1 : 0}" time="${report.durationMs / 1000}">`,
    `  <testcase classname="flowtest" name="${escapeXml(report.caseId)}" time="${report.durationMs / 1000}">${failure}</testcase>`,
    "</testsuite>",
    "",
  ].join("\n");
}

function createHtml(report: RunReport): string {
  const stageRows = report.stages
    .map(
      (stage) =>
        `<tr><td>${escapeXml(stage.id)}</td><td>${stage.status}</td><td>${stage.durationMs} ms</td><td>${escapeXml(stage.error?.message ?? "")}</td></tr>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FlowTest · ${escapeXml(report.caseId)}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 40px auto; max-width: 960px; padding: 0 24px; color: #17202a; }
    h1 { margin-bottom: 4px; } .passed { color: #147a42; } .failed { color: #b42318; }
    table { border-collapse: collapse; width: 100%; margin-top: 24px; }
    th, td { border-bottom: 1px solid #d8dee4; padding: 12px; text-align: left; vertical-align: top; }
    th { background: #f6f8fa; }
  </style>
</head>
<body>
  <h1>${escapeXml(report.caseName)}</h1>
  <p class="${report.status}">${report.status.toUpperCase()} · ${report.durationMs} ms · ${escapeXml(report.environment)}</p>
  <table><thead><tr><th>Stage</th><th>Status</th><th>Duration</th><th>Error</th></tr></thead><tbody>${stageRows}</tbody></table>
</body>
</html>
`;
}

export async function writeReports(
  report: RunReport,
  artifactDirectory: string,
  secrets: readonly string[] = [],
): Promise<void> {
  await mkdir(artifactDirectory, { recursive: true });
  const safeReport = redact(report, secrets) as RunReport;
  await Promise.all([
    writeFile(
      path.join(artifactDirectory, "report.json"),
      `${JSON.stringify(safeReport, null, 2)}\n`,
    ),
    writeFile(
      path.join(artifactDirectory, "junit.xml"),
      createJunit(safeReport),
    ),
    writeFile(
      path.join(artifactDirectory, "report.html"),
      createHtml(safeReport),
    ),
  ]);
}
