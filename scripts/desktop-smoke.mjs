import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright-core";

const projectRoot = resolve(import.meta.dirname, "..");
const executable = process.env.DESKTOP_EXECUTABLE
  ? resolve(process.env.DESKTOP_EXECUTABLE)
  : resolve(
      projectRoot,
      "src-tauri/target/debug/jianzhou-canvas-recorder.exe",
    );
const screenshotPath = resolve(
  projectRoot,
  process.env.DESKTOP_SCREENSHOT ?? "artifacts/desktop-smoke.png",
);
const reportPath = resolve(
  projectRoot,
  process.env.DESKTOP_REPORT ?? "artifacts/desktop-smoke.json",
);
const debuggingPort = Number(process.env.DESKTOP_DEBUG_PORT ?? 9333);
const debuggingUrl = `http://127.0.0.1:${debuggingPort}`;

const waitForEndpoint = async (timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${debuggingUrl}/json/version`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw lastError ?? new Error("WebView2 debugging endpoint did not start.");
};

const child = spawn(executable, [], {
  cwd: projectRoot,
  detached: false,
  windowsHide: false,
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: [
      `--remote-debugging-port=${debuggingPort}`,
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ].join(" "),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let browser;
try {
  await waitForEndpoint();
  browser = await chromium.connectOverCDP(debuggingUrl);
  const context = browser.contexts()[0];
  const page = context.pages()[0];
  if (!page) throw new Error("The desktop WebView did not expose a page.");

  const consoleErrors = [];
  const pageErrors = [];
  const assetResponses = [];
  const failedRequests = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.url().includes("/excalidraw-assets/")) {
      assetResponses.push({ url: response.url(), status: response.status() });
    }
  });
  page.on("requestfailed", (request) => {
    failedRequests.push({
      url: request.url(),
      error: request.failure()?.errorText ?? "unknown",
    });
  });

  await page.waitForSelector("canvas.excalidraw__canvas", { timeout: 30_000 });
  await page.waitForTimeout(1_500);

  const capabilities = await page.evaluate(async () => {
    const canvas = document.querySelector("canvas.excalidraw__canvas");
    const mediaStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    const mediaTracks = mediaStream.getTracks().map((track) => ({
      kind: track.kind,
      readyState: track.readyState,
    }));
    mediaStream.getTracks().forEach((track) => track.stop());

    let opfs = false;
    try {
      opfs = Boolean(await navigator.storage.getDirectory());
    } catch {
      opfs = false;
    }

    const localFontProbeUrl = `${location.origin}/excalidraw-assets/fonts/Cascadia/CascadiaCode-Regular.woff2`;
    const localFontProbeResponse = await fetch(localFontProbeUrl);
    return {
      title: document.title,
      url: location.href,
      secureContext: globalThis.isSecureContext,
      tauri: Boolean(globalThis.__TAURI_INTERNALS__),
      excalidrawAssetPath: globalThis.EXCALIDRAW_ASSET_PATH ?? null,
      localFontProbe: {
        url: localFontProbeUrl,
        status: localFontProbeResponse.status,
        contentType: localFontProbeResponse.headers.get("content-type"),
        bytes: (await localFontProbeResponse.arrayBuffer()).byteLength,
      },
      canvasLayers: document.querySelectorAll("canvas.excalidraw__canvas").length,
      canvasSize: canvas
        ? { width: canvas.width, height: canvas.height }
        : null,
      mediaRecorder: typeof MediaRecorder === "function",
      canvasCaptureStream:
        typeof HTMLCanvasElement.prototype.captureStream === "function",
      opfs,
      mediaTracks,
      folderDestinationEnabled:
        document.querySelector('option[value="folder"]')?.disabled === false,
      externalResources: performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((url) => {
          try {
            return new URL(url).origin !== location.origin;
          } catch {
            return false;
          }
        }),
    };
  });

  const expectedFontFallbacks = capabilities.externalResources.filter((url) =>
    /^https:\/\/esm\.sh\/@excalidraw\/excalidraw@[^/]+\/dist\/prod\/fonts\//.test(
      url,
    ),
  );
  const unexpectedExternalResources = capabilities.externalResources.filter(
    (url) => !expectedFontFallbacks.includes(url),
  );
  const localFontRoot = resolve(projectRoot, "dist/excalidraw-assets/fonts");
  const missingLocalFontFallbacks = [];
  for (const fallbackUrl of expectedFontFallbacks) {
    const relativeFontPath = decodeURIComponent(
      new URL(fallbackUrl).pathname.split("/dist/prod/fonts/")[1] ?? "",
    );
    const localFontPath = resolve(localFontRoot, relativeFontPath);
    if (!relativeFontPath || !localFontPath.startsWith(localFontRoot)) {
      missingLocalFontFallbacks.push(fallbackUrl);
      continue;
    }
    try {
      await access(localFontPath);
    } catch {
      missingLocalFontFallbacks.push(fallbackUrl);
    }
  }
  const unexpectedConsoleErrors = consoleErrors.filter(
    (message) =>
      !(
        message.includes("https://esm.sh/@excalidraw/excalidraw@") &&
        message.includes("violates the following Content Security Policy") &&
        message.includes("font-src")
      ),
  );
  const unexpectedFailedRequests = failedRequests.filter(
    ({ url }) => !expectedFontFallbacks.includes(url),
  );

  const failed =
    !capabilities.secureContext ||
    !capabilities.tauri ||
    capabilities.canvasLayers < 2 ||
    !capabilities.mediaRecorder ||
    !capabilities.canvasCaptureStream ||
    !capabilities.opfs ||
    !capabilities.folderDestinationEnabled ||
    capabilities.mediaTracks.length !== 2 ||
    capabilities.localFontProbe.status !== 200 ||
    capabilities.localFontProbe.bytes === 0 ||
    unexpectedExternalResources.length > 0 ||
    missingLocalFontFallbacks.length > 0 ||
    unexpectedConsoleErrors.length > 0 ||
    unexpectedFailedRequests.length > 0 ||
    pageErrors.length > 0 ||
    consoleErrors.some(
      (message) =>
        /uncaught/i.test(message) && !unexpectedConsoleErrors.includes(message),
    );

  await mkdir(dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath });
  const report = {
    ok: !failed,
    executable,
    capabilities,
    consoleErrors,
    pageErrors,
    assetResponses,
    failedRequests,
    offlineFonts: {
      blockedRemoteFallbacks: expectedFontFallbacks.length,
      unexpectedExternalResources,
      missingLocalFontFallbacks,
      unexpectedConsoleErrors,
      unexpectedFailedRequests,
    },
    screenshotPath,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  if (failed) process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  child.kill();
}
