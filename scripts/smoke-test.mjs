import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium } from "playwright-core";

const url = process.env.SMOKE_URL ?? "http://127.0.0.1:5173";
const screenshotPath =
  process.env.SMOKE_SCREENSHOT ?? "artifacts/smoke-floating-studio.png";
const compactTeleprompterScreenshotPath =
  process.env.COMPACT_TELEPROMPTER_SCREENSHOT ??
  "artifacts/compact-teleprompter.png";
const teleprompterControlsScreenshotPath =
  process.env.TELEPROMPTER_CONTROLS_SCREENSHOT ??
  "artifacts/teleprompter-speed-controls.png";
const edgeCandidates = [
  process.env.EDGE_PATH,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);

const resolveExecutable = async () => {
  for (const candidate of edgeCandidates) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // Try the next known Edge location.
    }
  }
  throw new Error("Microsoft Edge was not found. Set EDGE_PATH and retry.");
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const readRedPixelStats = (canvas) =>
  canvas.evaluate((element) => {
    const context = element.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Could not read the recording output pixels.");

    const pixels = context.getImageData(0, 0, element.width, element.height).data;
    let redPixels = 0;
    let redExcess = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index];
      const green = pixels[index + 1];
      const blue = pixels[index + 2];
      const alpha = pixels[index + 3];
      const excess = red - Math.max(green, blue);
      if (alpha >= 80 && red >= 180 && excess >= 24) {
        redPixels += 1;
        redExcess += excess;
      }
    }

    return { redPixels, redExcess };
  });

const selectLaserTool = async (page) => {
  const moreTools = page.locator(".App-toolbar__extra-tools-trigger");
  await moreTools.click();
  const laserTool = page.locator('[data-testid="toolbar-laser"]');
  await laserTool.waitFor({ state: "visible" });
  await laserTool.click();
  await page.waitForFunction(
    () =>
      document.querySelector(".app-shell")?.getAttribute("data-active-tool") ===
      "laser",
  );
};

const browser = await chromium.launch({
  executablePath: await resolveExecutable(),
  headless: true,
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-ui-for-media-stream",
  ],
});

const pageErrors = [];
const requestedUrls = [];
try {
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1600, height: 1000 },
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => requestedUrls.push(request.url()));

  // A cold Vite start may spend more than 30 seconds optimizing Excalidraw's
  // dependency graph. The canvas readiness checks below are the meaningful
  // product signal, so do not couple the smoke test to network-idle timing.
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  await page.locator("canvas.excalidraw__canvas.static").waitFor();
  await page.locator("canvas.excalidraw__canvas.interactive").waitFor();
  const outputCanvas = page.locator(".output-preview canvas");
  await outputCanvas.waitFor({ state: "visible" });
  await page.waitForFunction(
    () =>
      document.querySelector(".output-preview canvas")?.dataset.sourceReady ===
      "true",
    undefined,
    { timeout: 8_000 },
  );

  const layerCount = await page.locator("canvas.excalidraw__canvas").count();
  assert(layerCount >= 2, "Excalidraw did not expose both canvas layers.");

  const defaultOutputSize = await outputCanvas.evaluate((canvas) => ({
    width: canvas.width,
    height: canvas.height,
    phase: canvas.dataset.cameraPhase,
  }));
  assert(
    defaultOutputSize.width === 1280 && defaultOutputSize.height === 720,
    `Unexpected default output size: ${defaultOutputSize.width}x${defaultOutputSize.height}`,
  );
  assert(defaultOutputSize.phase === "idle", "Camera did not initialize to idle.");

  const sourceRailToggle = page.getByRole("button", {
    name: "展开讲解内容侧栏",
  });
  await sourceRailToggle.click();
  await page.getByRole("button", { name: "导入 PPT / PPTX" }).click();
  const presentationFallback = page.getByRole("dialog", {
    name: "PPT 导入说明",
  });
  await presentationFallback.waitFor({ state: "visible" });
  assert(
    await presentationFallback
      .getByRole("button", { name: "选择导出的 PDF" })
      .isVisible(),
    "PPT fallback did not expose the PDF import path.",
  );
  await presentationFallback.getByRole("button", { name: "暂不导入" }).click();
  await presentationFallback.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "折叠讲解内容侧栏" }).click();

  const baselineFrame = await outputCanvas.evaluate((canvas) =>
    canvas.toDataURL("image/png"),
  );
  await page.getByRole("button", { name: "提词器", exact: true }).click();
  const promptEditor = page.getByRole("textbox", { name: "提词器脚本" });
  await promptEditor.waitFor({ state: "visible" });
  await promptEditor.fill("SMOKE_TEST_PROMPTER_TEXT_SHOULD_NEVER_ENTER_OUTPUT");
  await page.waitForTimeout(250);
  const afterPromptEdit = await outputCanvas.evaluate((canvas) =>
    canvas.toDataURL("image/png"),
  );
  assert(
    baselineFrame === afterPromptEdit,
    "Opening or editing the teleprompter changed the recording output.",
  );

  const teleprompter = page.locator(".floating-teleprompter");
  const speedSlider = teleprompter.getByRole("slider", {
    name: "滚动速度",
  });
  const fontSizeSlider = teleprompter.getByRole("slider", {
    name: "文字大小",
  });
  const compactWidthSlider = teleprompter.getByRole("slider", {
    name: "精简阅读字幕条宽度",
  });
  const calibratedRanges = await page.evaluate(() => {
    const readRange = (label) => {
      const input = document.querySelector(`input[aria-label="${label}"]`);
      return input
        ? { min: Number(input.min), max: Number(input.max) }
        : null;
    };
    return {
      speed: readRange("滚动速度"),
      fontSize: readRange("文字大小"),
      compactWidth: readRange("精简阅读字幕条宽度"),
    };
  });
  assert(
    calibratedRanges.speed?.min === 1 &&
      calibratedRanges.speed?.max === 60 &&
      calibratedRanges.fontSize?.min === 14 &&
      calibratedRanges.compactWidth?.min === 220,
    `Teleprompter ranges were not recalibrated: ${JSON.stringify(calibratedRanges)}`,
  );

  await promptEditor.fill(
    Array.from(
      { length: 24 },
      (_, index) => `低速滚动累计测试第 ${index + 1} 行`,
    ).join("\n"),
  );
  await speedSlider.fill("4");
  const lowSpeedStart = await promptEditor.evaluate((element) => element.scrollTop);
  await teleprompter.locator(".floating-teleprompter__play").click();
  await page.waitForTimeout(1800);
  const lowSpeedEnd = await promptEditor.evaluate((element) => element.scrollTop);
  await teleprompter.locator(".floating-teleprompter__play").click();
  assert(
    lowSpeedEnd - lowSpeedStart >= 1,
    `Low teleprompter speed did not accumulate smoothly: ${JSON.stringify({ lowSpeedStart, lowSpeedEnd })}`,
  );
  await speedSlider.fill("16");
  await fontSizeSlider.fill("28");
  await compactWidthSlider.fill("680");
  await promptEditor.fill("SMOKE_TEST_PROMPTER_TEXT_SHOULD_NEVER_ENTER_OUTPUT");

  const teleprompterTitlebar = teleprompter.locator(
    ".floating-teleprompter__titlebar",
  );
  const initialTeleprompterBox = await teleprompter.boundingBox();
  const titlebarBox = await teleprompterTitlebar.boundingBox();
  assert(initialTeleprompterBox, "The teleprompter has no visible bounds.");
  assert(titlebarBox, "The teleprompter titlebar has no visible bounds.");

  const dragDelta = { x: 170, y: 105 };
  await page.mouse.move(titlebarBox.x + 110, titlebarBox.y + 24);
  await page.mouse.down();
  await page.mouse.move(
    titlebarBox.x + 110 + dragDelta.x,
    titlebarBox.y + 24 + dragDelta.y,
    { steps: 10 },
  );
  await page.mouse.up();
  await page.waitForFunction(
    ({ startX, startY }) => {
      const panel = document.querySelector(".floating-teleprompter");
      if (!panel) return false;
      const box = panel.getBoundingClientRect();
      return Math.abs(box.x - startX) > 80 && Math.abs(box.y - startY) > 50;
    },
    {
      startX: initialTeleprompterBox.x,
      startY: initialTeleprompterBox.y,
    },
  );
  const movedTeleprompterBox = await teleprompter.boundingBox();
  assert(movedTeleprompterBox, "The teleprompter disappeared after dragging.");
  assert(
    Math.abs(movedTeleprompterBox.width - initialTeleprompterBox.width) <= 1 &&
      Math.abs(movedTeleprompterBox.height - initialTeleprompterBox.height) <= 1,
    "Dragging the teleprompter unexpectedly resized it.",
  );

  await page.waitForTimeout(180);
  await mkdir(dirname(screenshotPath), { recursive: true });
  await teleprompter
    .locator(".floating-teleprompter__controls")
    .evaluate((element) => element.scrollTo({ left: 0, behavior: "instant" }));
  await teleprompter.screenshot({ path: teleprompterControlsScreenshotPath });
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await teleprompter
    .getByRole("button", { name: "关闭提词器", exact: true })
    .click();
  await teleprompter.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "提词器", exact: true }).click();
  await teleprompter.waitFor({ state: "visible" });
  const reopenedTeleprompterBox = await teleprompter.boundingBox();
  assert(reopenedTeleprompterBox, "The teleprompter did not reopen.");
  assert(
    Math.abs(reopenedTeleprompterBox.x - movedTeleprompterBox.x) <= 1 &&
      Math.abs(reopenedTeleprompterBox.y - movedTeleprompterBox.y) <= 1 &&
      Math.abs(reopenedTeleprompterBox.width - movedTeleprompterBox.width) <= 1 &&
      Math.abs(reopenedTeleprompterBox.height - movedTeleprompterBox.height) <= 1,
    `The teleprompter did not preserve its geometry after reopening: ${JSON.stringify({
      moved: movedTeleprompterBox,
      reopened: reopenedTeleprompterBox,
    })}`,
  );
  await page.waitForTimeout(900);
  const persistedTeleprompter = await page.evaluate(async () => {
    const store = await import("/src/core/projectStore.ts");
    const project = await store.loadCurrentCourseProject();
    return project?.teleprompter ?? null;
  });
  assert(
    persistedTeleprompter?.text ===
      "SMOKE_TEST_PROMPTER_TEXT_SHOULD_NEVER_ENTER_OUTPUT" &&
      Math.abs(persistedTeleprompter.position.x - movedTeleprompterBox.x) <= 1 &&
      Math.abs(persistedTeleprompter.position.y - movedTeleprompterBox.y) <= 1,
    `The project manifest did not persist teleprompter state: ${JSON.stringify(persistedTeleprompter)}`,
  );

  const compactChineseScript =
    "这是一段用于验证精简提词器的中文口播内容，它应该在透明字幕条里严格只露出两行，不应该再出现第三行遮挡正在讲解的画布内容。后续文字仍然可以通过自动滚动继续阅读。";
  await promptEditor.fill(compactChineseScript);
  await page
    .getByRole("slider", { name: "精简阅读背景浓度" })
    .fill("0");
  await page
    .getByRole("slider", { name: "精简阅读文字浓度" })
    .fill("55");

  const beforeCompactPrompt = await outputCanvas.evaluate((canvas) =>
    canvas.toDataURL("image/png"),
  );
  await teleprompter.getByRole("button", { name: "精简阅读", exact: true }).click();
  await page.waitForFunction(() => {
    const panel = document.querySelector(".floating-teleprompter");
    return (
      panel?.getAttribute("data-compact") === "true" &&
      panel?.getAttribute("data-pointer-passthrough") === "true"
    );
  });
  const compactBoxBeforeDrag = await teleprompter.boundingBox();
  assert(compactBoxBeforeDrag, "Compact teleprompter has no visible bounds.");
  const compactSurface = await page.evaluate(({ x, y }) => {
    const panel = document.querySelector(".floating-teleprompter");
    const script = document.querySelector(
      ".floating-teleprompter__compact-script",
    );
    const hit = document.elementFromPoint(x, y);
    const style = panel ? getComputedStyle(panel) : null;
    const scriptStyle = script ? getComputedStyle(script) : null;
    const lineHeight = Number.parseFloat(scriptStyle?.lineHeight ?? "0");
    const paddingTop = Number.parseFloat(scriptStyle?.paddingTop ?? "0");
    const paddingBottom = Number.parseFloat(scriptStyle?.paddingBottom ?? "0");
    const visibleLineCapacity =
      script instanceof HTMLElement && lineHeight > 0
        ? Math.floor(
            (script.clientHeight - paddingTop - paddingBottom + 0.5) /
              lineHeight,
          )
        : 0;
    return {
      panelPointerEvents: style?.pointerEvents,
      backdropFilter: style?.backdropFilter,
      opacityVariable: style?.getPropertyValue("--teleprompter-opacity").trim(),
      textOpacityVariable: style
        ?.getPropertyValue("--teleprompter-text-opacity")
        .trim(),
      textOpacity: scriptStyle?.opacity,
      backgroundClear: panel?.getAttribute("data-background-clear"),
      boxShadow: style?.boxShadow,
      lineHeight,
      clientHeight: script instanceof HTMLElement ? script.clientHeight : 0,
      paddingTop,
      paddingBottom,
      visibleLineCapacity,
      hitInsideTeleprompter: Boolean(hit?.closest(".floating-teleprompter")),
    };
  }, {
    x: compactBoxBeforeDrag.x + compactBoxBeforeDrag.width * 0.42,
    y: compactBoxBeforeDrag.y + compactBoxBeforeDrag.height * 0.5,
  });
  assert(
    compactBoxBeforeDrag.height <= 90 &&
      compactSurface.panelPointerEvents === "none" &&
      compactSurface.backdropFilter === "none" &&
      Number(compactSurface.opacityVariable) === 0 &&
      Number(compactSurface.textOpacityVariable) === 0.55 &&
      Number(compactSurface.textOpacity) === 0.55 &&
      compactSurface.backgroundClear === "true" &&
      compactSurface.boxShadow === "none" &&
      compactSurface.visibleLineCapacity === 2 &&
      compactSurface.hitInsideTeleprompter === false,
    `Compact teleprompter is not transparent/pass-through: ${JSON.stringify({ compactBoxBeforeDrag, compactSurface })}`,
  );
  await page.screenshot({ path: compactTeleprompterScreenshotPath });

  const compactDragButton = teleprompter.getByRole("button", {
    name: "移动",
    exact: true,
  });
  const compactDragBox = await compactDragButton.boundingBox();
  assert(compactDragBox, "Compact teleprompter drag handle is unavailable.");
  await page.mouse.move(
    compactDragBox.x + compactDragBox.width / 2,
    compactDragBox.y + compactDragBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(compactDragBox.x - 150, compactDragBox.y + 115, {
    steps: 10,
  });
  await page.mouse.up();
  const compactBoxAfterDrag = await teleprompter.boundingBox();
  assert(compactBoxAfterDrag, "Compact teleprompter disappeared after dragging.");
  assert(
    Math.hypot(
      compactBoxAfterDrag.x - compactBoxBeforeDrag.x,
      compactBoxAfterDrag.y - compactBoxBeforeDrag.y,
    ) > 80,
    "Compact teleprompter could not be freely repositioned.",
  );
  const afterCompactPrompt = await outputCanvas.evaluate((canvas) =>
    canvas.toDataURL("image/png"),
  );
  assert(
    beforeCompactPrompt === afterCompactPrompt,
    "Compact teleprompter changed the real recording output.",
  );
  await teleprompter.getByRole("button", { name: "完整", exact: true }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector(".floating-teleprompter")
        ?.getAttribute("data-compact") === "false",
  );
  await teleprompter
    .getByRole("button", { name: "关闭提词器", exact: true })
    .click();

  await page.getByRole("button", { name: /9:16/ }).click();
  await page.waitForFunction(() => {
    const canvas = document.querySelector(".output-preview canvas");
    return canvas?.width === 720 && canvas?.height === 1280;
  });
  await page.getByRole("button", { name: "完成选区", exact: true }).click();
  const verticalOutputSize = await outputCanvas.evaluate((canvas) => ({
    width: canvas.width,
    height: canvas.height,
  }));
  assert(
    verticalOutputSize.width === 720 && verticalOutputSize.height === 1280,
    `Unexpected vertical output size: ${verticalOutputSize.width}x${verticalOutputSize.height}`,
  );

  const customAspectInputs = page.locator(".custom-aspect-row input");
  assert(
    (await customAspectInputs.count()) === 2,
    "Custom aspect controls were not available.",
  );
  await customAspectInputs.nth(0).fill("1");
  await customAspectInputs.nth(1).fill("10000");
  await page.locator(".custom-aspect-row button").click();
  await page.waitForFunction(() => {
    const canvas = document.querySelector(".output-preview canvas");
    return canvas?.width === 720 && canvas?.height === 2880;
  });
  const extremePortraitOutputSize = await outputCanvas.evaluate((canvas) => ({
    width: canvas.width,
    height: canvas.height,
  }));
  assert(
    extremePortraitOutputSize.width >= 2 &&
      extremePortraitOutputSize.height >= 2 &&
      extremePortraitOutputSize.width <= 4_320 &&
      extremePortraitOutputSize.height <= 4_320 &&
      extremePortraitOutputSize.height / extremePortraitOutputSize.width <= 4.01,
    `Extreme portrait ratio was not safely bounded: ${JSON.stringify(extremePortraitOutputSize)}`,
  );

  await customAspectInputs.nth(0).fill("10000");
  await customAspectInputs.nth(1).fill("1");
  await page.locator(".custom-aspect-row button").click();
  await page.waitForFunction(() => {
    const canvas = document.querySelector(".output-preview canvas");
    return canvas?.width === 2880 && canvas?.height === 720;
  });
  const extremeLandscapeOutputSize = await outputCanvas.evaluate((canvas) => ({
    width: canvas.width,
    height: canvas.height,
  }));
  assert(
    extremeLandscapeOutputSize.width >= 2 &&
      extremeLandscapeOutputSize.height >= 2 &&
      extremeLandscapeOutputSize.width <= 4_320 &&
      extremeLandscapeOutputSize.height <= 4_320 &&
      extremeLandscapeOutputSize.width / extremeLandscapeOutputSize.height <= 4.01,
    `Extreme landscape ratio was not safely bounded: ${JSON.stringify(extremeLandscapeOutputSize)}`,
  );
  await page.getByRole("button", { name: "完成选区", exact: true }).click();

  const beforeStyle = await outputCanvas.evaluate((canvas) =>
    canvas.toDataURL("image/png"),
  );
  await page.getByRole("button", { name: "海盐蓝", exact: true }).click();
  await page.waitForTimeout(250);
  const afterStyle = await outputCanvas.evaluate((canvas) =>
    canvas.toDataURL("image/png"),
  );
  assert(beforeStyle !== afterStyle, "Changing the canvas style did not update output.");

  await page.getByRole("button", { name: /16:9/ }).click();
  await page.getByRole("button", { name: "完成选区", exact: true }).click();
  await page.waitForFunction(() => {
    const canvas = document.querySelector(".output-preview canvas");
    return canvas?.width === 1280 && canvas?.height === 720;
  });

  const interactiveCanvas = page.locator("canvas.excalidraw__canvas.interactive");
  const bounds = await interactiveCanvas.boundingBox();
  assert(bounds, "Interactive canvas has no visible bounds.");

  const autoZoomToggle = page
    .locator(".settings-section")
    .filter({ has: page.locator('select option[value="standard"]') })
    .locator("button.toggle-row");
  assert(
    (await autoZoomToggle.count()) === 1,
    "Could not uniquely locate the auto-camera toggle.",
  );
  if ((await autoZoomToggle.getAttribute("aria-pressed")) === "true") {
    await autoZoomToggle.click();
  }
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector(".output-preview canvas");
      return (
        canvas?.dataset.cameraPhase === "idle" &&
        Number(canvas.dataset.cameraZoom) <= 1.01
      );
    },
    undefined,
    { timeout: 6_000 },
  );

  await page.mouse.click(bounds.x + bounds.width * 0.45, bounds.y + 320);
  await selectLaserTool(page);
  await page.mouse.move(bounds.x + bounds.width * 0.22, bounds.y + 355);
  await page.waitForTimeout(80);
  const redPixelsBeforeLaser = await readRedPixelStats(outputCanvas);
  await page.mouse.down();
  for (let step = 1; step <= 18; step += 1) {
    await page.mouse.move(
      bounds.x + bounds.width * (0.22 + step * 0.027),
      bounds.y + 355 + Math.sin(step / 2.2) * 34,
      { steps: 2 },
    );
  }
  await page.waitForTimeout(120);
  const laserPixelFrame = await outputCanvas.evaluate((canvas) => ({
    zoom: Number(canvas.dataset.cameraZoom),
    phase: canvas.dataset.cameraPhase,
  }));
  const redPixelsDuringLaser = await readRedPixelStats(outputCanvas);
  assert(
    laserPixelFrame.phase === "idle" && laserPixelFrame.zoom <= 1.01,
    `Auto camera was not disabled for the laser pixel assertion: ${JSON.stringify(laserPixelFrame)}`,
  );
  assert(
    redPixelsDuringLaser.redPixels >= redPixelsBeforeLaser.redPixels + 300 &&
      redPixelsDuringLaser.redExcess >= redPixelsBeforeLaser.redExcess + 12_000,
    `Laser trail did not add enough red pixels to the fixed-camera output: ${JSON.stringify({
      before: redPixelsBeforeLaser,
      during: redPixelsDuringLaser,
    })}`,
  );
  await page.mouse.up();
  await page.waitForTimeout(1_000);
  await autoZoomToggle.click();
  await page.waitForFunction(
    (toggle) => toggle?.getAttribute("aria-pressed") === "true",
    await autoZoomToggle.elementHandle(),
  );
  // React commits the button state before the effect that re-enables the
  // CameraPlanner. Give that effect one paint before starting a new gesture.
  await page.waitForTimeout(180);

  await page.mouse.click(bounds.x + bounds.width * 0.45, bounds.y + 320);
  await selectLaserTool(page);
  const beforeLaser = await outputCanvas.evaluate((canvas) =>
    canvas.toDataURL("image/png"),
  );
  await page.mouse.move(bounds.x + bounds.width * 0.32, bounds.y + 340);
  await page.mouse.down();
  for (let step = 1; step <= 14; step += 1) {
    await page.mouse.move(
      bounds.x + bounds.width * (0.32 + step * 0.026),
      bounds.y + 340 + Math.sin(step / 2) * 48,
      { steps: 2 },
    );
  }
  await page.waitForTimeout(360);
  const laserDuringStroke = await outputCanvas.evaluate((canvas) => ({
    zoom: Number(canvas.dataset.cameraZoom),
    phase: canvas.dataset.cameraPhase,
    drawingActive: canvas.dataset.drawingActive,
    drawingGestures: canvas.dataset.drawingGestures,
    laserInputPoints: canvas.dataset.laserInputPoints,
    laserDrawnFrames: canvas.dataset.laserDrawnFrames,
    frame: canvas.toDataURL("image/png"),
  }));
  assert(
    laserDuringStroke.phase === "drawing" && laserDuringStroke.zoom > 1.1,
    `Laser did not engage auto camera: ${JSON.stringify({
      ...laserDuringStroke,
      frame: "[omitted]",
    })}`,
  );
  assert(
    laserDuringStroke.frame !== beforeLaser,
    "Laser trail did not appear in the composited output.",
  );
  await page.mouse.up();
  await page.mouse.move(bounds.x + bounds.width - 6, 8);
  await page.waitForFunction(
    () =>
      document.querySelector(".output-preview canvas")?.dataset.cameraPhase ===
      "idle",
    undefined,
    { timeout: 6_000 },
  );

  await page.keyboard.press("p");
  await page.mouse.move(bounds.x + bounds.width * 0.3, bounds.y + 420);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.62, bounds.y + 485, {
    steps: 12,
  });
  await page.waitForTimeout(320);
  const drawingDuringStroke = await outputCanvas.evaluate((canvas) => ({
    zoom: Number(canvas.dataset.cameraZoom),
    phase: canvas.dataset.cameraPhase,
  }));
  assert(
    drawingDuringStroke.phase === "drawing" && drawingDuringStroke.zoom > 1.1,
    `Persistent drawing did not engage auto camera: ${JSON.stringify(drawingDuringStroke)}`,
  );
  await page.mouse.up();
  await page.waitForFunction(
    () =>
      document.querySelector(".output-preview canvas")?.dataset.cameraPhase ===
      "idle",
    undefined,
    { timeout: 6_000 },
  );

  await page.keyboard.press("1");
  await page.mouse.move(bounds.x + bounds.width * 0.3, bounds.y + 260);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.68, bounds.y + 560, {
    steps: 8,
  });
  await page.waitForTimeout(260);
  const zoomDuringSelection = await outputCanvas.evaluate((canvas) => ({
    zoom: Number(canvas.dataset.cameraZoom),
    phase: canvas.dataset.cameraPhase,
  }));
  await page.mouse.up();
  assert(
    zoomDuringSelection.phase === "idle" && zoomDuringSelection.zoom <= 1.01,
    `Selection incorrectly triggered auto camera: ${JSON.stringify(zoomDuringSelection)}`,
  );

  await page.getByRole("button", { name: "开始录制", exact: true }).click();
  const stopButton = page.getByRole("button", { name: "结束", exact: true });
  await stopButton.waitFor({ timeout: 12_000 });
  await selectLaserTool(page);
  await page.mouse.move(bounds.x + bounds.width * 0.42, bounds.y + 420);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.6, bounds.y + 500, {
    steps: 12,
  });
  await page.mouse.up();
  await page.waitForTimeout(800);

  const downloadPromise = page.waitForEvent("download", { timeout: 12_000 });
  await stopButton.click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  assert(downloadPath, "Recording download did not produce a local file.");
  const downloadStats = await stat(downloadPath);
  assert(
    downloadStats.size > 2_000,
    `Recording output is unexpectedly small: ${downloadStats.size} bytes`,
  );
  await page.getByRole("dialog", { name: "录制完成回看" }).waitFor();

  assert(pageErrors.length === 0, `Runtime page errors: ${pageErrors.join(" | ")}`);
  const expectedOrigin = new URL(url).origin;
  const externalRequests = requestedUrls.filter((requestedUrl) => {
    const requested = new URL(requestedUrl);
    return (
      requested.protocol !== "data:" &&
      requested.protocol !== "blob:" &&
      requested.origin !== expectedOrigin
    );
  });
  assert(
    externalRequests.length === 0,
    `Unexpected external network requests: ${externalRequests.join(", ")}`,
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        layerCount,
        defaultOutputSize,
        verticalOutputSize,
        extremePortraitOutputSize,
        extremeLandscapeOutputSize,
        teleprompterGeometry: {
          initial: initialTeleprompterBox,
          moved: movedTeleprompterBox,
          reopened: reopenedTeleprompterBox,
        },
        teleprompterProjectPersistence: {
          textLength: persistedTeleprompter.text.length,
          position: persistedTeleprompter.position,
          size: persistedTeleprompter.size,
        },
        teleprompterCalibration: {
          ranges: calibratedRanges,
          lowSpeedScrollDelta: lowSpeedEnd - lowSpeedStart,
          testedSpeedSetting: 4,
          testedEffectivePixelsPerSecond: 1,
          screenshotPath: teleprompterControlsScreenshotPath,
        },
        compactTeleprompter: {
          beforeDrag: compactBoxBeforeDrag,
          afterDrag: compactBoxAfterDrag,
          surface: compactSurface,
          excludedFromOutput: beforeCompactPrompt === afterCompactPrompt,
          screenshotPath: compactTeleprompterScreenshotPath,
        },
        laserPixelAssertion: {
          before: redPixelsBeforeLaser,
          during: redPixelsDuringLaser,
        },
        laserDuringStroke: {
          phase: laserDuringStroke.phase,
          zoom: laserDuringStroke.zoom,
        },
        drawingDuringStroke,
        zoomDuringSelection,
        screenshotPath,
        externalRequests: externalRequests.length,
        recording: {
          filename: download.suggestedFilename(),
          bytes: downloadStats.size,
        },
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
