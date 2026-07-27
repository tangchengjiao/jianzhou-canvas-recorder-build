import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const chromePath =
  process.env.CHROME_PATH ??
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
const appUrl = process.env.APP_URL ?? "http://127.0.0.1:5173/";
const artifactDir = path.resolve("artifacts", "audit-2026-07-15");
const downloadDir = path.join(artifactDir, "chrome-downloads");
const profileDir = await mkdtemp(
  path.join(os.tmpdir(), "excalidraw-recorder-cdp-"),
);

await mkdir(artifactDir, { recursive: true });
await mkdir(downloadDir, { recursive: true });

const browser = spawn(
  chromePath,
  [
    "--headless=new",
    "--no-first-run",
    "--disable-default-apps",
    "--hide-scrollbars",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--window-size=2048,1080",
    appUrl,
  ],
  { windowsHide: true, stdio: "ignore" },
);

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitForFile = async (filename, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(filename, "utf8");
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`Timed out waiting for ${filename}`);
};

const activePort = await waitForFile(
  path.join(profileDir, "DevToolsActivePort"),
);
const [port] = activePort.trim().split(/\r?\n/);

let page;
for (let attempt = 0; attempt < 80; attempt += 1) {
  try {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(
      (response) => response.json(),
    );
    page = targets.find((target) => target.type === "page");
    if (page) break;
  } catch {
    // Chrome may need another moment to expose the target list.
  }
  await sleep(100);
}
if (!page) throw new Error("Chrome did not expose a page target");

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) {
        this.events.push(message);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

const client = new CdpClient(page.webSocketDebuggerUrl);
await client.connect();
await client.send("Page.enable");
await client.send("Runtime.enable");
await client.send("Log.enable");
await client.send("Emulation.setDeviceMetricsOverride", {
  width: 2048,
  height: 1080,
  deviceScaleFactor: 1,
  mobile: false,
});
await client.send("Page.setDownloadBehavior", {
  behavior: "allow",
  downloadPath: downloadDir,
});

const evaluate = async (expression) => {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? "Evaluation failed");
  }
  return result.result?.value;
};

const screenshot = async (filename) => {
  const result = await client.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  await writeFile(path.join(artifactDir, filename), result.data, "base64");
};

const clickButton = (text, selector = "button") =>
  evaluate(`(() => {
    const target = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((element) => element.textContent?.trim() === ${JSON.stringify(text)});
    if (!target) return false;
    target.click();
    return true;
  })()`);

const clickButtonContaining = (text, selector = "button") =>
  evaluate(`(() => {
    const target = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((element) => element.textContent?.includes(${JSON.stringify(text)}));
    if (!target) return false;
    target.click();
    return true;
  })()`);

const waitFor = async (expression, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return true;
    await sleep(200);
  }
  return false;
};

try {
  await waitFor("document.readyState === 'complete'", 10_000);
  await waitFor("Boolean(document.querySelector('.record-button'))", 15_000);
  await sleep(1_500);

  const capabilities = await evaluate(`({
    mediaRecorder: typeof MediaRecorder !== "undefined",
    canvasCapture: typeof HTMLCanvasElement.prototype.captureStream === "function",
    vp8: typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("video/webm;codecs=vp8"),
    viewport: [innerWidth, innerHeight]
  })`);

  await clickButton("工作台");
  await sleep(350);
  await screenshot("04-settings-workbench.png");

  const layout = await evaluate(`(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const value = element.getBoundingClientRect();
      return { x: value.x, y: value.y, width: value.width, height: value.height };
    };
    return {
      dock: rect(".recorder-dock"),
      panel: rect(".workspace-panel"),
      excalidrawToolbar: rect(".App-toolbar"),
      zoom: rect(".zoom-actions"),
      canvas: rect(".excalidraw-stage")
    };
  })()`);

  await clickButton("预览", ".workspace-panel__header button");
  await sleep(800);
  await screenshot("05-output-preview.png");
  const outputReady = await evaluate(`(() => {
    const canvas = document.querySelector(".output-preview canvas");
    return canvas ? {
      width: canvas.width,
      height: canvas.height,
      sourceReady: canvas.dataset.sourceReady,
      compositorFps: canvas.dataset.compositorFps
    } : null;
  })()`);

  await clickButton("设置", ".workspace-panel__header button");
  const cameraToggleClicked = await clickButtonContaining(
    "加入摄像头",
    ".toggle-row",
  );
  const cameraReady = await waitFor(`[...document.querySelectorAll(".toggle-row")]
    .some((button) => button.textContent?.includes("加入摄像头") && button.getAttribute("aria-pressed") === "true")`);
  const microphoneToggleClicked = await clickButtonContaining(
    "录制麦克风",
    ".toggle-row",
  );
  const microphoneEnabled = await waitFor(`[...document.querySelectorAll(".toggle-row")]
    .some((button) => button.textContent?.includes("录制麦克风") && button.getAttribute("aria-pressed") === "true")`);
  await clickButton("预览", ".workspace-panel__header button");
  await sleep(1_000);
  await screenshot("09-camera-output-preview.png");

  await clickButton("关闭", ".workspace-panel__header button");
  await clickButton("录制", ".record-button");
  await sleep(1_200);
  await screenshot("06-countdown.png");
  const recordingStarted = await waitFor(
    "Boolean(document.querySelector('.recording-clock'))",
    10_000,
  );
  await sleep(2_200);
  await screenshot("07-recording.png");
  const recordingClock = await evaluate(
    "document.querySelector('.recording-clock')?.textContent?.trim() ?? null",
  );
  const stopClicked = await clickButton("结束", ".stop-button");
  const recordingStopped = await waitFor(
    "Boolean(document.querySelector('.record-button'))",
    15_000,
  );
  await sleep(1_000);
  const finalStatus = await evaluate(
    "document.querySelector('.recorder-status')?.textContent?.trim() ?? null",
  );

  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 980,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(350);
  await screenshot("08-responsive-980x720.png");

  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 2048,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(300);
  await clickButton("工作台");
  await sleep(200);
  const cameraStoppedForScreenshot = await clickButtonContaining(
    "加入摄像头",
    ".toggle-row",
  );
  await waitFor(`[...document.querySelectorAll(".toggle-row")]
    .some((button) => button.textContent?.includes("加入摄像头") && button.getAttribute("aria-pressed") === "false")`);
  await clickButton("关闭", ".workspace-panel__header button");
  await sleep(300);
  const menuButtonClicked = await evaluate(`(() => {
    const target = [...document.querySelectorAll("button")].find((button) => {
      const rect = button.getBoundingClientRect();
      return rect.x < 90 && rect.y < 90 && rect.width <= 80 && rect.height <= 80;
    });
    if (!target) return false;
    target.click();
    return true;
  })()`);
  await sleep(300);
  const visibleMenuText = await evaluate(
    `[...document.querySelectorAll("button, [role='menuitem']")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map((element) => element.textContent?.trim())
      .filter(Boolean)`,
  );
  const darkModeClicked = await clickButtonContaining(
    "深色模式",
    "button, [role='menuitem']",
  );
  await sleep(650);
  const darkThemeActive = await evaluate(
    `document.querySelector(".app-shell")?.getAttribute("data-editor-theme") === "dark"`,
  );
  const darkMenuOpened = await evaluate(`(() => {
    const menuIsVisible = [...document.querySelectorAll("button, [role='menuitem']")]
      .some((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && element.textContent?.includes("导出图片");
      });
    if (menuIsVisible) return true;
    const target = [...document.querySelectorAll("button")].find((button) => {
      const rect = button.getBoundingClientRect();
      return rect.x < 90 && rect.y < 90 && rect.width <= 80 && rect.height <= 80;
    });
    if (!target) return false;
    target.click();
    return true;
  })()`);
  await sleep(300);
  await screenshot("11-dark-menu-open-2048x1080.png");

  const downloads = await readdir(downloadDir);
  const browserErrors = client.events
    .filter(
      (event) =>
        event.method === "Runtime.exceptionThrown" ||
        (event.method === "Log.entryAdded" &&
          ["error", "warning"].includes(event.params?.entry?.level)),
    )
    .map((event) => ({ method: event.method, params: event.params }));

  const summary = {
    capabilities,
    layout,
    outputReady,
    cameraToggleClicked,
    cameraReady,
    microphoneToggleClicked,
    microphoneEnabled,
    recordingStarted,
    recordingClock,
    stopClicked,
    recordingStopped,
    finalStatus,
    cameraStoppedForScreenshot,
    menuButtonClicked,
    visibleMenuText,
    darkModeClicked,
    darkThemeActive,
    darkMenuOpened,
    downloads,
    browserErrors,
  };
  await writeFile(
    path.join(artifactDir, "chrome-audit-summary.json"),
    JSON.stringify(summary, null, 2),
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} finally {
  client.close();
  browser.kill();
  if (
    profileDir.startsWith(os.tmpdir()) &&
    path.basename(profileDir).startsWith("excalidraw-recorder-cdp-")
  ) {
    await sleep(250);
    await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
