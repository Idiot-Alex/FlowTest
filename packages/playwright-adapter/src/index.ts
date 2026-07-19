import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";

import type { TestCaseConfig } from "@flowtest/config-schema";

type BrowserConfig = TestCaseConfig["browser"];
type ArtifactConfig = TestCaseConfig["artifacts"];
type ArtifactMode = ArtifactConfig["screenshot"];

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  finalize(success: boolean): Promise<void>;
}

function shouldRetain(mode: ArtifactMode, success: boolean): boolean {
  return (
    mode === "always" ||
    (!success && ["on-failure", "retain-on-failure"].includes(mode))
  );
}

export async function createBrowserSession(
  browserConfig: BrowserConfig,
  artifactConfig: ArtifactConfig,
  artifactDirectory: string,
  allowedHosts: readonly string[],
): Promise<BrowserSession> {
  await mkdir(artifactDirectory, { recursive: true });
  const videoDirectory = path.join(artifactDirectory, "video");
  const recordsVideo = artifactConfig.video !== "off";
  if (recordsVideo) {
    await mkdir(videoDirectory, { recursive: true });
  }

  const browser = await chromium.launch({ headless: browserConfig.headless });
  const context = await browser.newContext({
    locale: browserConfig.locale,
    viewport: browserConfig.viewport,
    ...(browserConfig.storageState === undefined
      ? {}
      : { storageState: path.resolve(browserConfig.storageState) }),
    ...(recordsVideo ? { recordVideo: { dir: videoDirectory } } : {}),
  });

  context.setDefaultTimeout(browserConfig.timeoutMs);
  context.setDefaultNavigationTimeout(browserConfig.timeoutMs);

  await context.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    let parsed: URL;
    try {
      parsed = new URL(requestUrl);
    } catch {
      await route.abort("blockedbyclient");
      return;
    }
    if (
      ["http:", "https:"].includes(parsed.protocol) &&
      !allowedHosts.includes(parsed.hostname)
    ) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });

  const traceStarted = artifactConfig.trace !== "off";
  if (traceStarted) {
    await context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    });
  }

  const page = await context.newPage();
  const consoleEvents: Array<Record<string, unknown>> = [];
  const networkEvents: Array<Record<string, unknown>> = [];

  if (artifactConfig.console) {
    page.on("console", (message) => {
      consoleEvents.push({
        at: new Date().toISOString(),
        type: message.type(),
        text: message.text(),
      });
    });
    page.on("pageerror", (error) => {
      consoleEvents.push({
        at: new Date().toISOString(),
        type: "pageerror",
        text: error.message,
      });
    });
  }

  if (artifactConfig.network !== "off") {
    page.on("requestfailed", (request) => {
      networkEvents.push({
        at: new Date().toISOString(),
        method: request.method(),
        url: request.url(),
        error: request.failure()?.errorText ?? "unknown",
      });
    });
    page.on("response", (response) => {
      if (artifactConfig.network === "all" || response.status() >= 400) {
        networkEvents.push({
          at: new Date().toISOString(),
          method: response.request().method(),
          url: response.url(),
          status: response.status(),
        });
      }
    });
  }

  let finalized = false;
  return {
    browser,
    context,
    page,
    async finalize(success: boolean) {
      if (finalized) {
        return;
      }
      finalized = true;

      if (
        shouldRetain(artifactConfig.screenshot, success) &&
        !page.isClosed()
      ) {
        await page.screenshot({
          path: path.join(artifactDirectory, "final.png"),
          fullPage: true,
        });
      }

      if (traceStarted) {
        if (shouldRetain(artifactConfig.trace, success)) {
          await context.tracing.stop({
            path: path.join(artifactDirectory, "trace.zip"),
          });
        } else {
          await context.tracing.stop();
        }
      }

      if (artifactConfig.console) {
        await writeFile(
          path.join(artifactDirectory, "console.json"),
          `${JSON.stringify(consoleEvents, null, 2)}\n`,
        );
      }
      if (artifactConfig.network !== "off") {
        await writeFile(
          path.join(artifactDirectory, "network.json"),
          `${JSON.stringify(networkEvents, null, 2)}\n`,
        );
      }

      await context.close();
      await browser.close();

      if (recordsVideo && !shouldRetain(artifactConfig.video, success)) {
        await rm(videoDirectory, { recursive: true, force: true });
      }
    },
  };
}
