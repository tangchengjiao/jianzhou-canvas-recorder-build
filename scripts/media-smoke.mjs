import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { chromium } from "playwright-core";

const url = process.env.SMOKE_URL ?? "http://127.0.0.1:5173";
const designQaScreenshotPath =
  process.env.DESIGN_QA_SCREENSHOT ?? "artifacts/design-qa-current.png";
const designQaNarrowScreenshotPath =
  process.env.DESIGN_QA_NARROW_SCREENSHOT ??
  "artifacts/design-qa-980x720.png";
const edgeCandidates = [
  process.env.EDGE_PATH,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const resolveEdgeExecutable = async () => {
  for (const candidate of edgeCandidates) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // Try the next configured or conventional Edge location.
    }
  }
  throw new Error("A compatible Chromium browser was not found. Set EDGE_PATH and retry.");
};

const runProcess = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr });
    };

    const timer = setTimeout(() => {
      child?.kill();
      finish({ code: null, error: new Error(`Command timed out: ${command}`) });
    }, timeoutMs);

    try {
      child = spawn(command, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ code: null, error });
      return;
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => finish({ code: null, error }));
    child.once("close", (code) => finish({ code, error: null }));
  });

const probeRecording = async (recordingPath, expectedSize) => {
  const command = process.env.FFPROBE_PATH?.trim() || "ffprobe";
  const availability = await runProcess(command, ["-version"], 3_000);
  if (availability.code !== 0) {
    return {
      status: "skipped",
      reason: process.env.FFPROBE_PATH
        ? `FFPROBE_PATH is unavailable: ${
            availability.error?.message ||
            availability.stderr.trim() ||
            "unknown error"
          }`
        : "ffprobe was not found on PATH",
    };
  }

  const result = await runProcess(
    command,
    [
      "-v",
      "error",
      "-show_entries",
      "stream=index,codec_type,width,height,duration:format=duration",
      "-of",
      "json",
      recordingPath,
    ],
    10_000,
  );
  assert(
    result.code === 0,
    `ffprobe failed: ${result.error?.message ?? result.stderr.trim()}`,
  );

  let probe;
  try {
    probe = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`ffprobe returned invalid JSON: ${error.message}`);
  }

  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  assert(video, "ffprobe did not find a video stream.");
  assert(audio, "ffprobe did not find an audio stream from the fake microphone.");
  assert(
    Number(video.width) === expectedSize.width &&
      Number(video.height) === expectedSize.height,
    `Unexpected encoded size: ${video.width}x${video.height}; expected ${expectedSize.width}x${expectedSize.height}.`,
  );

  const durations = [
    probe.format?.duration,
    ...streams.map((stream) => stream.duration),
  ]
    .map(Number)
    .filter((duration) => Number.isFinite(duration) && duration > 0);
  assert(durations.length > 0, "ffprobe did not report a valid recording duration.");

  return {
    status: "passed",
    video: {
      width: Number(video.width),
      height: Number(video.height),
    },
    audioStream: true,
    durationSeconds: Math.max(...durations),
  };
};

let browser;
try {
  browser = await chromium.launch({
    executablePath: await resolveEdgeExecutable(),
    headless: true,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 2048, height: 1080 },
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(url, { waitUntil: "networkidle", timeout: 12_000 });
  const outputCanvas = page.locator(".output-preview canvas");
  await outputCanvas.waitFor({ state: "visible", timeout: 8_000 });
  await page.waitForFunction(
    () =>
      document.querySelector(".output-preview canvas")?.dataset.sourceReady ===
      "true",
    undefined,
    { timeout: 8_000 },
  );

  const outputSize = await outputCanvas.evaluate((canvas) => ({
    width: canvas.width,
    height: canvas.height,
  }));
  assert(outputSize.width > 0 && outputSize.height > 0, "Output canvas has no size.");

  const microphoneToggle = page.getByRole("button", {
    name: /录制麦克风/,
  });
  await microphoneToggle.click();
  assert(
    (await microphoneToggle.getAttribute("aria-pressed")) === "true",
    "Microphone recording was not enabled.",
  );

  const cameraToggle = page.getByRole("button", { name: /加入摄像头/ });
  await cameraToggle.click();
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector(".output-preview canvas");
      return (
        canvas?.dataset.webcamReady === "true" &&
        Number(canvas.dataset.webcamDrawnFrames) > 0
      );
    },
    undefined,
    { timeout: 10_000 },
  );
  await page.locator(".camera-monitor video").waitFor({
    state: "visible",
    timeout: 5_000,
  });
  assert(
    (await page.locator('video[data-media-input-source="camera"]').count()) === 1,
    "The WebKit-compatible camera source video is not attached to the DOM.",
  );

  const webcamBeforeRecording = await outputCanvas.evaluate((canvas) => ({
    ready: canvas.dataset.webcamReady,
    drawnFrames: Number(canvas.dataset.webcamDrawnFrames),
  }));
  assert(webcamBeforeRecording.ready === "true", "Fake webcam is not compositor-ready.");
  assert(
    webcamBeforeRecording.drawnFrames > 0,
    "The compositor did not draw a fake webcam frame.",
  );

  const cameraMonitor = page.locator(".camera-monitor");
  const monitorBeforeDrag = await cameraMonitor.boundingBox();
  const stageBounds = await page.locator(".excalidraw-stage").boundingBox();
  assert(monitorBeforeDrag && stageBounds, "Camera drag geometry is unavailable.");
  await page.mouse.move(
    monitorBeforeDrag.x + monitorBeforeDrag.width / 2,
    monitorBeforeDrag.y + monitorBeforeDrag.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    stageBounds.x + stageBounds.width * 0.52,
    stageBounds.y + stageBounds.height * 0.52,
    { steps: 12 },
  );
  await page.mouse.up();
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector(".output-preview canvas");
      const saved = JSON.parse(
        localStorage.getItem("excalidraw-recorder:webcam-layout:v1") ?? "null",
      );
      return (
        document.querySelector(".camera-monitor")?.classList.contains(
          "camera-monitor--custom",
        ) &&
        canvas?.dataset.webcamPlacementMode === "custom" &&
        saved?.placement &&
        Math.abs(Number(canvas.dataset.webcamPlacementX) - saved.placement.x) < 0.01 &&
        Math.abs(Number(canvas.dataset.webcamPlacementY) - saved.placement.y) < 0.01
      );
    },
  );
  const monitorAfterDrag = await cameraMonitor.boundingBox();
  assert(monitorAfterDrag, "Camera monitor disappeared after dragging.");
  assert(
    Math.hypot(
      monitorAfterDrag.x - monitorBeforeDrag.x,
      monitorAfterDrag.y - monitorBeforeDrag.y,
    ) > 120,
    "Dragging did not materially move the camera monitor.",
  );
  const webcamPlacement = await outputCanvas.evaluate((canvas) => ({
    mode: canvas.dataset.webcamPlacementMode,
    x: Number(canvas.dataset.webcamPlacementX),
    y: Number(canvas.dataset.webcamPlacementY),
    saved: JSON.parse(
      localStorage.getItem("excalidraw-recorder:webcam-layout:v1") ?? "null",
    ),
  }));
  assert(
    webcamPlacement.mode === "custom" &&
      webcamPlacement.x > 0.3 &&
      webcamPlacement.x < 0.7 &&
      webcamPlacement.y > 0.3 &&
      webcamPlacement.y < 0.7 &&
      webcamPlacement.saved?.placement,
    `Custom webcam placement was not shared/persisted: ${JSON.stringify(webcamPlacement)}`,
  );

  await page.getByRole("button", { name: "关闭工作台", exact: true }).click();
  await page.getByRole("button", { name: "提词器", exact: true }).click();
  await page.locator(".floating-teleprompter").waitFor({
    state: "visible",
    timeout: 5_000,
  });
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: designQaScreenshotPath });
  await page.setViewportSize({ width: 980, height: 720 });
  await page.waitForTimeout(250);
  await page.screenshot({ path: designQaNarrowScreenshotPath });
  await page.setViewportSize({ width: 2048, height: 1080 });
  await page.waitForTimeout(250);

  await page.getByRole("button", { name: "开始录制", exact: true }).click();
  const stopButton = page.getByRole("button", { name: "结束", exact: true });
  await stopButton.waitFor({ state: "visible", timeout: 12_000 });
  await page.waitForTimeout(2_200);

  const downloadPromise = page.waitForEvent("download", { timeout: 15_000 });
  await stopButton.click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  assert(downloadPath, "Recording download did not produce a local file.");
  const recordingStats = await stat(downloadPath);
  assert(
    recordingStats.size > 2_000,
    `Recording is unexpectedly small: ${recordingStats.size} bytes.`,
  );

  const recordingSinkEvidence = await page.evaluate(async () => {
    const sink = await import("/src/core/recordingSink.ts");
    const inspections = await sink.inspectOPFSRecordingJournals();
    return {
      opfsSupported: sink.canUseOPFSRecordingSink(),
      finalized: inspections.find((entry) => entry.status === "finalized") ?? null,
    };
  });
  assert(
    recordingSinkEvidence.opfsSupported === true &&
      recordingSinkEvidence.finalized?.actualFileBytes === recordingStats.size &&
      recordingSinkEvidence.finalized?.durability === "committed",
    `Recorder did not use the durable OPFS sink: ${JSON.stringify(recordingSinkEvidence)}`,
  );

  await page.locator(".camera-monitor").waitFor({
    state: "detached",
    timeout: 5_000,
  });
  await page.waitForFunction(
    () => !document.querySelector('video[data-media-input-source="camera"]'),
    undefined,
    { timeout: 5_000 },
  );
  await page.waitForFunction(
    () =>
      document.querySelector(".output-preview canvas")?.dataset.webcamReady ===
      "false",
    undefined,
    { timeout: 5_000 },
  );

  const reviewVideo = page.locator(".recording-result video");
  await reviewVideo.waitFor({ state: "visible", timeout: 8_000 });
  const browserMetadata = await reviewVideo.evaluate(
    (video) =>
      new Promise((resolve, reject) => {
        const timeoutId = window.setTimeout(
          () => reject(new Error("Timed out waiting for loadedmetadata.")),
          8_000,
        );
        const cleanup = () => {
          window.clearTimeout(timeoutId);
          video.removeEventListener("loadedmetadata", onMetadata);
          video.removeEventListener("error", onError);
        };
        const onMetadata = () => {
          cleanup();
          resolve({
            width: video.videoWidth,
            height: video.videoHeight,
            duration: video.duration,
          });
        };
        const onError = () => {
          cleanup();
          reject(
            new Error(video.error?.message || "Browser could not decode recording."),
          );
        };

        if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
          onMetadata();
          return;
        }
        video.addEventListener("loadedmetadata", onMetadata, { once: true });
        video.addEventListener("error", onError, { once: true });
      }),
  );
  assert(
    browserMetadata.width === outputSize.width &&
      browserMetadata.height === outputSize.height,
    `Browser decoded ${browserMetadata.width}x${browserMetadata.height}; expected ${outputSize.width}x${outputSize.height}.`,
  );

  const ffprobe = await probeRecording(downloadPath, outputSize);
  assert(pageErrors.length === 0, `Runtime page errors: ${pageErrors.join(" | ")}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        fakeMediaOnly: true,
        outputSize,
        webcamBeforeRecording,
        webcamPlacement,
        designQaScreenshotPath,
        designQaNarrowScreenshotPath,
        cameraMonitorRemovedAfterStop: true,
        recording: {
          filename: download.suggestedFilename(),
          bytes: recordingStats.size,
          browserMetadata,
          sink: {
            kind: "opfs",
            durability: recordingSinkEvidence.finalized.durability,
            committedBytes: recordingSinkEvidence.finalized.committedBytes,
          },
        },
        ffprobe,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
}
