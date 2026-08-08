import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium } from "playwright-core";

const url = process.env.SMOKE_URL ?? "http://127.0.0.1:5173";
const screenshotPath =
  process.env.CONTENT_SMOKE_SCREENSHOT ?? "artifacts/content-smoke.png";
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

const buildTwoPagePdf = () => {
  const pageOne = "0.94 0.24 0.18 rg 0 0 800 600 re f\n";
  const pageTwo = "0.16 0.38 0.92 rg 0 0 800 600 re f\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 600] /Resources << >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(pageOne, "ascii")} >>\nstream\n${pageOne}endstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 600] /Resources << >> /Contents 6 0 R >>",
    `<< /Length ${Buffer.byteLength(pageTwo, "ascii")} >>\nstream\n${pageTwo}endstream`,
  ];

  let document = "%PDF-1.4\n%LOCAL\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets[index + 1] = Buffer.byteLength(document, "ascii");
    document += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(document, "ascii");
  document += `xref\n0 ${objects.length + 1}\n`;
  document += "0000000000 65535 f \n";
  for (let index = 1; index <= objects.length; index += 1) {
    document += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  document += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(document, "ascii");
};

const canvasStats = (locator) =>
  locator.evaluate((canvas) => {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Could not read a canvas in content smoke.");
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let alphaPixels = 0;
    let coloredPixels = 0;
    let redPixels = 0;
    let greenPixels = 0;
    let bluePixels = 0;
    let yellowPixels = 0;
    let hash = 2166136261;

    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index];
      const green = pixels[index + 1];
      const blue = pixels[index + 2];
      const alpha = pixels[index + 3];
      if (alpha > 10) alphaPixels += 1;
      if (alpha > 80 && Math.max(red, green, blue) - Math.min(red, green, blue) > 35) {
        coloredPixels += 1;
      }
      if (red > 190 && green < 120 && blue < 120) redPixels += 1;
      if (green > 130 && red < 100 && blue < 150) greenPixels += 1;
      if (blue > 150 && red < 130 && green < 180) bluePixels += 1;
      if (red > 190 && green > 160 && blue < 100) yellowPixels += 1;

      // A bounded sample is enough to distinguish full-page source frames.
      if ((index >> 2) % 37 === 0) {
        hash ^= red;
        hash = Math.imul(hash, 16777619);
        hash ^= green;
        hash = Math.imul(hash, 16777619);
        hash ^= blue;
        hash = Math.imul(hash, 16777619);
        hash ^= alpha;
        hash = Math.imul(hash, 16777619);
      }
    }
    return {
      width: canvas.width,
      height: canvas.height,
      alphaPixels,
      coloredPixels,
      redPixels,
      greenPixels,
      bluePixels,
      yellowPixels,
      hash: hash >>> 0,
    };
  });

const alphaBounds = (locator) =>
  locator.evaluate((canvas) => {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Could not inspect annotation bounds.");
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let minX = canvas.width;
    let minY = canvas.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        if (pixels[(y * canvas.width + x) * 4 + 3] <= 10) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    if (maxX < 0) return null;
    return {
      minX: minX / canvas.width,
      minY: minY / canvas.height,
      maxX: maxX / canvas.width,
      maxY: maxY / canvas.height,
      centerX: (minX + maxX) / 2 / canvas.width,
      centerY: (minY + maxY) / 2 / canvas.height,
    };
  });

const waitForIdleCamera = (page) =>
  page.waitForFunction(
    () => {
      const canvas = document.querySelector(".output-preview canvas");
      return (
        canvas?.dataset.cameraPhase === "idle" &&
        Number(canvas.dataset.cameraZoom) <= 1.01
      );
    },
    undefined,
    { timeout: 8_000 },
  );

const drawGesture = async (page, canvas, options = {}) => {
  const bounds = await canvas.boundingBox();
  assert(bounds, "Document interaction canvas has no visible bounds.");
  const startX = bounds.x + bounds.width * (options.startX ?? 0.38);
  const startY = bounds.y + bounds.height * (options.startY ?? 0.35);
  const endX = bounds.x + bounds.width * (options.endX ?? 0.62);
  const endY = bounds.y + bounds.height * (options.endY ?? 0.57);
  const steps = options.steps ?? 18;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    await page.mouse.move(
      startX + (endX - startX) * progress,
      startY + (endY - startY) * progress + Math.sin(progress * Math.PI * 3) * 18,
      { steps: 2 },
    );
  }
  if (options.hold) await page.waitForTimeout(options.hold);
  return { bounds, endX, endY };
};

const clickDocumentToolbar = async (page, selector) => {
  const tool = page.locator(selector);
  if (!(await tool.isVisible().catch(() => false))) {
    const handle = page.locator(".document-toolbar-handle");
    await handle.waitFor({ state: "visible" });
    await handle.click();
    await tool.waitFor({ state: "visible" });
  }
  await tool.click();
};

const browser = await chromium.launch({
  executablePath: await resolveExecutable(),
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"],
});

const pageErrors = [];
const consoleErrors = [];
const requestedUrls = [];
try {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => requestedUrls.push(request.url()));

  await page.goto(url, { waitUntil: "networkidle" });
  const testImagePng = Buffer.from(
    (
      await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 800;
        canvas.height = 1200;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Could not create the passive PNG fixture.");
        context.fillStyle = "#fffdf8";
        context.fillRect(0, 0, 800, 1200);
        for (const [x, y, color] of [
          [0, 0, "#ef4444"],
          [610, 0, "#22c55e"],
          [0, 1010, "#3b82f6"],
          [610, 1010, "#facc15"],
        ]) {
          context.fillStyle = color;
          context.fillRect(x, y, 190, 190);
        }
        context.fillStyle = "#f1efff";
        context.fillRect(120, 270, 560, 660);
        context.strokeStyle = "#5b52cb";
        context.lineWidth = 12;
        context.strokeRect(120, 270, 560, 660);
        context.strokeStyle = "#292630";
        context.lineWidth = 22;
        context.lineCap = "round";
        for (const [x1, y, x2] of [
          [200, 410, 600],
          [200, 520, 540],
          [200, 630, 610],
          [200, 740, 500],
        ]) {
          context.beginPath();
          context.moveTo(x1, y);
          context.lineTo(x2, y);
          context.stroke();
        }
        return canvas.toDataURL("image/png").split(",", 2)[1];
      })
    ),
    "base64",
  );
  await page.evaluate(async () => {
    const databases = await indexedDB.databases();
    await Promise.all(
      databases
        .map((database) => database.name)
        .filter(Boolean)
        .map(
          (name) =>
            new Promise((resolve) => {
              const request = indexedDB.deleteDatabase(name);
              request.onsuccess = () => resolve(undefined);
              request.onerror = () => resolve(undefined);
              request.onblocked = () => resolve(undefined);
            }),
        ),
    );
    localStorage.removeItem("excalidraw-recorder:diagnostics:v1");
  });
  await page.reload({ waitUntil: "networkidle" });
  const app = page.locator(".app-shell");
  const outputCanvas = page.locator(".output-preview canvas");
  await outputCanvas.waitFor({ state: "visible" });
  await page.waitForFunction(
    () =>
      document.querySelector(".output-preview canvas")?.dataset.sourceReady ===
      "true",
    undefined,
    { timeout: 8_000 },
  );
  const whiteboardOutput = await outputCanvas.evaluate((canvas) =>
    canvas.toDataURL("image/png"),
  );

  const productKernel = await page.evaluate(async () => {
    const model = await import("/src/core/courseProject.ts");
    const store = await import("/src/core/projectStore.ts");
    const platform = await import("/src/platform/webHostBridge.ts");
    const contentRegistry = await import("/src/content/adapterRegistry.ts");
    const coordinatorContract = await import(
      "/src/core/projectCoordinator.contract.ts"
    );
    const now = 1_784_097_600_000;
    const project = model.createCourseProject({
      id: "project-content-smoke",
      title: "Content smoke course",
      now,
      sources: [
        {
          id: "source-content-smoke",
          assetFormat: "pdf",
          surfaceMode: "paged",
          renderEngine: "pdfjs",
          title: "Smoke PDF",
          mimeType: "application/pdf",
          fileName: "smoke.pdf",
          assetId: "asset-content-smoke",
          pageCount: 2,
          currentPageIndex: 0,
          fitMode: "contain",
          annotationsByPage: {},
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    await store.saveCurrentCourseProject(project);
    const restored = await store.loadCurrentCourseProject();
    const listed = await store.listCourseProjects();
    const legacy = model.readCourseProject({
      id: "legacy-project",
      title: "Legacy",
      kind: "pdf",
      assetId: "legacy-asset",
      fileName: "legacy.pdf",
      currentPage: 1,
      pageCount: 2,
      savedAt: now,
    });
    const future = model.tryReadCourseProject({
      schemaVersion: model.COURSE_PROJECT_SCHEMA_VERSION + 1,
      id: "future",
    });

    const bridge = new platform.WebHostBridge();
    const coordinator = await coordinatorContract.runProjectCoordinatorContract();
    const registry = contentRegistry.createDefaultContentAdapterRegistry();
    const registryRouting = {
      pdf: registry.resolve(
        new File(["pdf"], "lesson.pdf", { type: "application/pdf" }),
      )?.kind,
      markdown: registry.resolve(
        new File(["# title"], "lesson.md", { type: "text/markdown" }),
      )?.kind,
      html: registry.resolve(
        new File(["<h1>title</h1>"], "lesson.html", { type: "text/html" }),
      )?.kind,
      passiveImage: registry.resolve(
        new File(["png"], "lesson.png", { type: "image/png" }),
      )?.kind,
      svgRejected:
        registry.resolve(
          new File(["<svg/>"] , "unsafe.svg", { type: "image/svg+xml" }),
        ) === null,
    };
    const capabilities = bridge.getCapabilities();
    let unsupportedError = null;
    try {
      await bridge.convertPresentationToPdf({
        sourcePath: "C:/untrusted/demo.pptx",
      });
    } catch (error) {
      unsupportedError = {
        name: error instanceof Error ? error.name : typeof error,
        capability:
          error && typeof error === "object" && "capability" in error
            ? error.capability
            : null,
      };
    }
    return {
      schemaVersion: project.schemaVersion,
      restoredId: restored?.id ?? null,
      restoredFormat: restored?.sources[0]?.assetFormat ?? null,
      listContainsProject: listed.some((item) => item.id === project.id),
      legacyMigratedFrom: legacy.migratedFromVersion,
      legacyAxes: legacy.project.sources[0]
        ? {
            assetFormat: legacy.project.sources[0].assetFormat,
            surfaceMode: legacy.project.sources[0].surfaceMode,
            renderEngine: legacy.project.sources[0].renderEngine,
          }
        : null,
      futureReadOnly: !future.ok && future.readOnly,
      nativePresentationSupported:
        capabilities["presentation-to-pdf"].supported,
      opfsDetected: capabilities["origin-private-file-system"].supported,
      unsupportedError,
      coordinator,
      registryRouting,
    };
  });
  assert(
    productKernel.schemaVersion === 1 &&
      productKernel.restoredId === "project-content-smoke" &&
      productKernel.restoredFormat === "pdf" &&
      productKernel.listContainsProject,
    `Versioned course project persistence failed: ${JSON.stringify(productKernel)}`,
  );
  assert(
    productKernel.registryRouting?.pdf === "pdf" &&
      productKernel.registryRouting?.markdown === "markdown" &&
      productKernel.registryRouting?.html === "html" &&
      productKernel.registryRouting?.passiveImage === "image" &&
      productKernel.registryRouting?.svgRejected === true,
    `Content adapter registry routing failed: ${JSON.stringify(productKernel.registryRouting)}`,
  );
  assert(
    productKernel.coordinator?.initializedMode === "created-from-legacy" &&
      productKernel.coordinator?.recordingCount === 1 &&
      productKernel.coordinator?.recordingStorage === "opfs" &&
      productKernel.coordinator?.teleprompterText === "Project-specific script" &&
      productKernel.coordinator?.restoredMode === "loaded" &&
      productKernel.coordinator?.futureReadOnly === true &&
      productKernel.coordinator?.futureSaveCount === 0,
    `Course project coordinator contract failed: ${JSON.stringify(productKernel.coordinator)}`,
  );
  assert(
    productKernel.legacyMigratedFrom === 0 &&
      productKernel.legacyAxes?.assetFormat === "pdf" &&
      productKernel.legacyAxes?.surfaceMode === "paged" &&
      productKernel.legacyAxes?.renderEngine === "pdfjs" &&
      productKernel.futureReadOnly,
    `Course project migration/version guard failed: ${JSON.stringify(productKernel)}`,
  );
  assert(
    productKernel.nativePresentationSupported === false &&
      productKernel.unsupportedError?.name === "UnsupportedCapabilityError" &&
      productKernel.unsupportedError?.capability === "presentation-to-pdf",
    `Web HostBridge pretended to provide desktop capabilities: ${JSON.stringify(productKernel)}`,
  );

  const importBudgets = await page.evaluate(async () => {
    const imageModule = await import("/src/content/imageAdapter.ts");
    const pdfModule = await import("/src/content/pdfAdapter.ts");
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47], 0);
    png.set([0x49, 0x48, 0x44, 0x52], 12);
    const view = new DataView(png.buffer);
    view.setUint32(16, imageModule.IMAGE_IMPORT_LIMITS.maxDimension + 1);
    view.setUint32(20, 1);
    let imageRejected = false;
    try {
      await imageModule.ImageContentAdapter.load(
        new Blob([png], { type: "image/png" }),
      );
    } catch (error) {
      imageRejected = String(error?.message ?? error).includes("像素尺寸过大");
    }

    class OversizedPdfBlob extends Blob {
      get size() {
        return pdfModule.PDF_IMPORT_LIMITS.maxBytes + 1;
      }
    }
    let pdfRejected = false;
    try {
      await pdfModule.PdfContentAdapter.load(
        new OversizedPdfBlob(["%PDF-1.4"], { type: "application/pdf" }),
      );
    } catch (error) {
      pdfRejected = String(error?.message ?? error).includes("轻量导入限制");
    }
    return { imageRejected, pdfRejected };
  });
  assert(
    importBudgets.imageRejected && importBudgets.pdfRejected,
    `Import budgets were not enforced before decoding: ${JSON.stringify(importBudgets)}`,
  );

  const imageInput = page.locator(
    '.content-file-input[type="file"][accept^="image/"]',
  );
  await imageInput.setInputFiles({
    name: "content-smoke-portrait.png",
    mimeType: "image/png",
    buffer: testImagePng,
  });
  await page.waitForFunction(
    () =>
      document.querySelector(".app-shell")?.getAttribute("data-content-source") ===
      "image",
    undefined,
    { timeout: 10_000 },
  );

  const documentStage = page.locator(".document-stage");
  await documentStage.waitFor({ state: "visible" });
  const documentCanvases = documentStage.locator("canvas");
  assert(
    (await documentCanvases.count()) === 3,
    "DocumentStage did not expose base, committed, and transient canvases.",
  );
  const imageSourceAtLoad = await app.getAttribute("data-content-source");
  const imageCanvasLayers = await documentCanvases.count();
  const baseCanvas = documentStage.locator(".document-stage__canvas--base");
  const committedCanvas = documentStage.locator(
    ".document-stage__canvas--committed",
  );
  const transientCanvas = documentStage.locator(
    ".document-stage__canvas--transient",
  );
  await page.waitForFunction(() => {
    const canvas = document.querySelector(
      ".document-stage__canvas--base",
    );
    return canvas instanceof HTMLCanvasElement && canvas.width > 300 && canvas.height > 200;
  });
  await page.waitForTimeout(350);

  const imageBaseStats = await canvasStats(baseCanvas);
  assert(
    imageBaseStats.redPixels > 1_000 &&
      imageBaseStats.greenPixels > 1_000 &&
      imageBaseStats.bluePixels > 1_000 &&
      imageBaseStats.yellowPixels > 1_000,
    `Imported image corners were not all rendered: ${JSON.stringify(imageBaseStats)}`,
  );
  await page.waitForFunction(
    () =>
      document.querySelector(".output-preview canvas")?.dataset.sourceReady ===
      "true",
  );
  const imageOutput = await outputCanvas.evaluate((canvas) =>
    canvas.toDataURL("image/png"),
  );
  assert(imageOutput !== whiteboardOutput, "Imported image did not reach the output compositor.");

  await clickDocumentToolbar(page, '.document-toolbar__tool[data-tool="pen"]');
  await page.waitForFunction(
    () => document.querySelector(".document-stage")?.getAttribute("data-tool") === "pen",
  );
  const commitsBeforePen = await outputCanvas.evaluate((canvas) =>
    Number(canvas.dataset.stableSceneCommits),
  );
  await drawGesture(page, transientCanvas);
  await page.mouse.up();
  await page.waitForFunction(() => {
    const canvas = document.querySelector(
      ".document-stage__canvas--committed",
    );
    if (!(canvas instanceof HTMLCanvasElement)) return false;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return false;
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] > 10) return true;
    }
    return false;
  });
  await page.waitForFunction(
    (minimum) =>
      Number(
        document.querySelector(".output-preview canvas")?.dataset
          .stableSceneCommits,
      ) > minimum,
    commitsBeforePen,
    { timeout: 8_000 },
  );
  await waitForIdleCamera(page);
  await page.waitForTimeout(650);
  const committedAfterPen = await canvasStats(committedCanvas);
  const outputWithAnnotation = await outputCanvas.evaluate((canvas) =>
    canvas.toDataURL("image/png"),
  );
  assert(
    committedAfterPen.alphaPixels > 100,
    `Pen stroke was not committed after pointer-up: ${JSON.stringify(committedAfterPen)}`,
  );

  const commitsBeforeUndo = await outputCanvas.evaluate((canvas) =>
    Number(canvas.dataset.stableSceneCommits),
  );
  await clickDocumentToolbar(page, '.document-toolbar button[aria-label^="撤销当前页"]');
  await page.waitForFunction(() => {
    const canvas = document.querySelector(
      ".document-stage__canvas--committed",
    );
    if (!(canvas instanceof HTMLCanvasElement)) return false;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return false;
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] > 10) return false;
    }
    return true;
  });
  await page.waitForFunction(
    (minimum) =>
      Number(
        document.querySelector(".output-preview canvas")?.dataset
          .stableSceneCommits,
      ) > minimum,
    commitsBeforeUndo,
    { timeout: 8_000 },
  );
  await page.waitForTimeout(300);
  const outputAfterUndo = await outputCanvas.evaluate((canvas) =>
    canvas.toDataURL("image/png"),
  );
  assert(
    outputWithAnnotation !== outputAfterUndo,
    "Removing the committed annotation did not change the composited output.",
  );

  // A page-space stroke must follow the imported image when the same source
  // switches between contain and cover. Legacy stage-space storage would keep
  // the stroke at the same canvas x coordinate and fail this assertion.
  const pageSpaceGesture = await transientCanvas.evaluate((canvas) => {
    const sourceWidth = 800;
    const sourceHeight = 1200;
    const scale = Math.min(
      canvas.width / sourceWidth,
      canvas.height / sourceHeight,
    );
    const destinationWidth = sourceWidth * scale;
    const destinationHeight = sourceHeight * scale;
    const destinationX = (canvas.width - destinationWidth) / 2;
    const destinationY = (canvas.height - destinationHeight) / 2;
    return {
      startX: (destinationX + destinationWidth * 0.22) / canvas.width,
      startY: (destinationY + destinationHeight * 0.48) / canvas.height,
      endX: (destinationX + destinationWidth * 0.3) / canvas.width,
      endY: (destinationY + destinationHeight * 0.52) / canvas.height,
    };
  });
  await drawGesture(page, transientCanvas, {
    ...pageSpaceGesture,
    steps: 10,
  });
  await page.mouse.up();
  await page.waitForFunction(() => {
    const canvas = document.querySelector(
      ".document-stage__canvas--committed",
    );
    if (!(canvas instanceof HTMLCanvasElement)) return false;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    return Boolean(
      context?.getImageData(0, 0, canvas.width, canvas.height).data.some(
        (value, index) => index % 4 === 3 && value > 10,
      ),
    );
  });
  const containAnnotationBounds = await alphaBounds(committedCanvas);
  assert(containAnnotationBounds, "Contain mode did not render the page-space stroke.");

  await page.getByRole("button", { name: "填满舞台，允许裁切" }).click();
  await page.waitForFunction(
    () => document.querySelector(".document-stage")?.getAttribute("data-fit-mode") === "cover",
  );
  await page.waitForTimeout(250);
  const coverAnnotationBounds = await alphaBounds(committedCanvas);
  assert(coverAnnotationBounds, "Cover mode lost the page-space stroke.");
  assert(
    containAnnotationBounds.centerX - coverAnnotationBounds.centerX > 0.08,
    `Annotation stayed in stage space instead of following the page: ${JSON.stringify({ containAnnotationBounds, coverAnnotationBounds })}`,
  );

  await page.getByRole("button", { name: "完整显示内容，允许留边" }).click();
  await page.waitForFunction(
    () => document.querySelector(".document-stage")?.getAttribute("data-fit-mode") === "contain",
  );
  await page.waitForTimeout(250);
  const restoredContainBounds = await alphaBounds(committedCanvas);
  assert(
    restoredContainBounds &&
      Math.abs(restoredContainBounds.centerX - containAnnotationBounds.centerX) < 0.015 &&
      Math.abs(restoredContainBounds.centerY - containAnnotationBounds.centerY) < 0.015,
    `Annotation did not return to the same page position: ${JSON.stringify({ containAnnotationBounds, restoredContainBounds })}`,
  );
  await clickDocumentToolbar(page, '.document-toolbar button[aria-label^="清空当前页"]');
  await page.waitForFunction(() => {
    const canvas = document.querySelector(
      ".document-stage__canvas--committed",
    );
    if (!(canvas instanceof HTMLCanvasElement)) return false;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    return !context?.getImageData(0, 0, canvas.width, canvas.height).data.some(
      (value, index) => index % 4 === 3 && value > 10,
    );
  });

  await clickDocumentToolbar(page, '.document-toolbar__tool[data-tool="laser"]');
  await page.waitForFunction(
    () => document.querySelector(".document-stage")?.getAttribute("data-tool") === "laser",
  );
  const laserBefore = await outputCanvas.evaluate((canvas) => ({
    inputPoints: Number(canvas.dataset.laserInputPoints),
    maxZoom: Number(canvas.dataset.maxCameraZoom),
  }));
  await drawGesture(page, transientCanvas, {
    startX: 0.35,
    startY: 0.42,
    endX: 0.67,
    endY: 0.58,
    steps: 22,
    hold: 320,
  });
  try {
    await page.waitForFunction(
      (baseline) => {
        const canvas = document.querySelector(".output-preview canvas");
        return (
          Number(canvas?.dataset.laserInputPoints) >= baseline + 3 &&
          Number(canvas?.dataset.maxCameraZoom) > 1.1
        );
      },
      laserBefore.inputPoints,
      { timeout: 8_000 },
    );
  } catch (error) {
    const debug = await page.evaluate(() => {
      const canvas = document.querySelector(".output-preview canvas");
      const stage = document.querySelector(".document-stage");
      return {
        output: canvas instanceof HTMLCanvasElement ? { ...canvas.dataset } : null,
        stageTool: stage?.getAttribute("data-tool"),
        toolbarVisible: Boolean(document.querySelector(".document-toolbar")),
        handleVisible: Boolean(document.querySelector(".document-toolbar-handle")),
      };
    });
    throw new Error(`Document laser wait failed: ${JSON.stringify(debug)}; ${error.message}`);
  }
  const laserDuringGesture = await outputCanvas.evaluate((canvas) => ({
    phase: canvas.dataset.cameraPhase,
    zoom: Number(canvas.dataset.cameraZoom),
    maxZoom: Number(canvas.dataset.maxCameraZoom),
    inputPoints: Number(canvas.dataset.laserInputPoints),
    drawnFrames: Number(canvas.dataset.laserDrawnFrames),
  }));
  await page.mouse.up();
  assert(
    laserDuringGesture.maxZoom > 1.1 &&
      laserDuringGesture.inputPoints >= laserBefore.inputPoints + 3,
    `Document laser did not drive trail and camera: ${JSON.stringify(laserDuringGesture)}`,
  );

  await page.locator(".source-rail__whiteboard-button").click();
  await page.waitForFunction(
    () =>
      document.querySelector(".app-shell")?.getAttribute("data-content-source") ===
        "whiteboard" && !document.querySelector(".document-stage"),
  );
  assert(
    (await page.locator('.excalidraw-source[data-active="true"]').count()) === 1,
    "Returning from image mode did not restore Excalidraw.",
  );

  const pdfInput = page.locator(
    '.content-file-input[type="file"][accept*="application/pdf"]',
  );
  const pdfPayload = buildTwoPagePdf();
  const directPdfProbe = await page.evaluate(async (bytes) => {
    const serializeError = (error) => {
      const values = [];
      let current = error;
      while (current && values.length < 6) {
        values.push({
          name: current instanceof Error ? current.name : typeof current,
          message: current instanceof Error ? current.message : String(current),
          code: current && typeof current === "object" ? current.code : undefined,
        });
        current = current && typeof current === "object" ? current.cause : null;
      }
      return values;
    };
    try {
      const { PdfContentAdapter } = await import("/src/content/pdfAdapter.ts");
      const adapter = await PdfContentAdapter.load(new Uint8Array(bytes), {
        title: "direct-probe.pdf",
      });
      const result = {
        ok: true,
        pageCount: adapter.getMetadata().pageCount,
      };
      await adapter.dispose();
      return result;
    } catch (error) {
      return { ok: false, errors: serializeError(error) };
    }
  }, [...pdfPayload]);
  assert(
    directPdfProbe.ok && directPdfProbe.pageCount === 2,
    `Direct PDF adapter probe failed: ${JSON.stringify(directPdfProbe)}`,
  );
  await pdfInput.setInputFiles({
    name: "content-smoke-two-pages.pdf",
    mimeType: "application/pdf",
    buffer: pdfPayload,
  });
  try {
    await page.waitForFunction(
      () =>
        document.querySelector(".app-shell")?.getAttribute("data-content-source") ===
        "pdf",
      undefined,
      { timeout: 30_000 },
    );
  } catch (error) {
    const visibleError = await page.locator(".source-rail__error").textContent().catch(() => null);
    const diagnostics = await page.evaluate(() =>
      localStorage.getItem("excalidraw-recorder:diagnostics:v1"),
    );
    throw new Error(
      `Generated PDF did not open${visibleError ? `: ${visibleError}` : ""}. ${error.message}\n` +
        `Console: ${consoleErrors.join(" | ")}\nDiagnostics: ${diagnostics}\n` +
        `Requests: ${requestedUrls.slice(-12).join(" | ")}`,
    );
  }
  const pdfPages = page.locator(".source-rail__page-button");
  await pdfPages.nth(1).waitFor({ state: "visible", timeout: 12_000 });
  assert((await pdfPages.count()) === 2, "The generated two-page PDF did not expose two pages.");
  await page.waitForTimeout(350);
  const pdfPageOneStats = await canvasStats(baseCanvas);

  await clickDocumentToolbar(page, '.document-toolbar__tool[data-tool="pen"]');
  await drawGesture(page, transientCanvas, {
    startX: 0.42,
    startY: 0.4,
    endX: 0.59,
    endY: 0.54,
    steps: 14,
  });
  await page.mouse.up();
  await page.waitForFunction(() => {
    const canvas = document.querySelector(
      ".document-stage__canvas--committed",
    );
    if (!(canvas instanceof HTMLCanvasElement)) return false;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return false;
    return context.getImageData(0, 0, canvas.width, canvas.height).data.some(
      (value, index) => index % 4 === 3 && value > 10,
    );
  });
  const pdfPageOneAnnotation = await canvasStats(committedCanvas);

  await pdfPages.nth(1).click();
  await page.waitForFunction(
    () =>
      document
        .querySelectorAll(".source-rail__page-button")[1]
        ?.getAttribute("aria-current") === "page",
    undefined,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(300);
  const pdfPageTwoStats = await canvasStats(baseCanvas);
  const pdfPageTwoAnnotation = await canvasStats(committedCanvas);
  assert(
    pdfPageOneStats.hash !== pdfPageTwoStats.hash,
    "PDF navigation did not change the rendered page.",
  );
  assert(
    pdfPageOneAnnotation.alphaPixels > 100 && pdfPageTwoAnnotation.alphaPixels === 0,
    "Page-one annotation leaked onto PDF page two.",
  );

  await pdfPages.nth(0).click();
  await page.waitForFunction(
    () =>
      document
        .querySelectorAll(".source-rail__page-button")[0]
        ?.getAttribute("aria-current") === "page",
    undefined,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(250);
  const restoredPageOneAnnotation = await canvasStats(committedCanvas);
  assert(
    restoredPageOneAnnotation.alphaPixels > 100,
    "Returning to PDF page one did not restore its annotation.",
  );

  await mkdir(dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true });

  // The source Blob, current page and page-scoped annotations must survive a
  // real application reload, not just React state changes.
  await page.waitForTimeout(900);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(
    () =>
      document.querySelector(".app-shell")?.getAttribute("data-content-source") ===
        "pdf" &&
      document
        .querySelectorAll(".source-rail__page-button")[0]
        ?.getAttribute("aria-current") === "page",
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(350);
  const reloadedPageOneAnnotation = await canvasStats(committedCanvas);
  assert(
    reloadedPageOneAnnotation.alphaPixels > 100,
    "Reloading the app did not restore the PDF asset and its page-one annotation.",
  );

  await page.locator(".source-rail__whiteboard-button").click();
  await page.waitForFunction(
    () =>
      document.querySelector(".app-shell")?.getAttribute("data-content-source") ===
      "whiteboard",
  );

  await page.evaluate(() => {
    globalThis.__appSafeHtmlPwned = 0;
  });
  const htmlInput = page.locator(
    '.content-file-input[type="file"][accept^="text/html"]',
  );
  const htmlPayload = `<!doctype html><html><head>
    <script>globalThis.__appSafeHtmlPwned=91</script>
    <style>
      html,body{margin:0;width:100%;height:100%;background:#17324d url(https://example.invalid/style.png)}
      .visual-card{position:absolute;left:12%;top:14%;width:54%;height:48%;border-radius:38px;background:#ff4f76;color:white}
      .visual-card h1{margin:54px;font:700 72px/1.1 Arial,sans-serif}
    </style>
    </head><body onload="globalThis.__appSafeHtmlPwned=92">
    <main class="visual-card"><h1>静态视觉 HTML</h1></main>
    <svg width="210" height="210" viewBox="0 0 210 210" style="position:absolute;right:7%;bottom:8%">
      <circle cx="105" cy="105" r="92" fill="#5ee6a8" />
    </svg>
    <iframe src="https://example.invalid/frame"></iframe>
    <img src="https://example.invalid/tracker.png" alt="远程图">
    </body></html>`;
  await htmlInput.setInputFiles({
    name: "content-smoke-safe.html",
    mimeType: "text/html",
    buffer: Buffer.from(htmlPayload, "utf8"),
  });
  await page.waitForFunction(
    () =>
      document.querySelector(".app-shell")?.getAttribute("data-content-source") ===
        "html" &&
      document.querySelectorAll(".source-rail__page-button").length === 1,
    undefined,
    { timeout: 20_000 },
  );
  const htmlPageCount = await page.locator(".source-rail__page-button").count();
  const htmlScriptValue = await page.evaluate(() => globalThis.__appSafeHtmlPwned);
  assert(htmlScriptValue === 0, `Imported HTML executed script: ${htmlScriptValue}`);
  const htmlPageOne = await canvasStats(baseCanvas);
  assert(
    htmlPageOne.redPixels > 1_000 && htmlPageOne.greenPixels > 100,
    `Static HTML CSS/SVG did not reach the document stage: ${JSON.stringify(htmlPageOne)}`,
  );
  await page.waitForTimeout(900);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(
    () =>
      document.querySelector(".app-shell")?.getAttribute("data-content-source") ===
        "html" &&
      document
        .querySelectorAll(".source-rail__page-button")[0]
        ?.getAttribute("aria-current") === "page",
    undefined,
    { timeout: 30_000 },
  );
  const htmlProjectSource = await page.evaluate(async () => {
    const store = await import("/src/core/projectStore.ts");
    const project = await store.loadCurrentCourseProject();
    return project?.sources.find((source) => source.assetFormat === "html") ?? null;
  });
  assert(
    htmlProjectSource?.renderEngine === "safe-html" &&
      htmlProjectSource?.currentPageIndex === 0,
    `Static HTML project metadata was not persisted: ${JSON.stringify(htmlProjectSource)}`,
  );
  await page.locator(".source-rail__whiteboard-button").click();
  await page.waitForFunction(
    () =>
      document.querySelector(".app-shell")?.getAttribute("data-content-source") ===
      "whiteboard",
  );

  const markdownInput = page.locator(
    '.content-file-input[type="file"][accept^="text/markdown"]',
  );
  await page
    .locator("label", { hasText: "分页方式" })
    .locator("select")
    .selectOption("document");
  await page
    .locator("label", { hasText: "页面方向" })
    .locator("select")
    .selectOption("portrait");
  await page
    .locator("label", { hasText: "内容主题" })
    .locator("select")
    .selectOption("warm");
  const markdownPayload = Array.from(
    { length: 64 },
    (_, index) =>
      `## 课程段落 ${index + 1}\n\n这是第 ${index + 1} 个本地 Markdown 讲解段落，包含 **重点**、\`代码\` 和稳定分页内容。`,
  ).join("\n\n");
  await markdownInput.setInputFiles({
    name: "content-smoke-course.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(markdownPayload, "utf8"),
  });
  await page.waitForFunction(
    () =>
      document.querySelector(".app-shell")?.getAttribute("data-content-source") ===
        "markdown" &&
      document.querySelectorAll(".source-rail__page-button").length > 2,
    undefined,
    { timeout: 20_000 },
  );
  const markdownPages = page.locator(".source-rail__page-button");
  const markdownPageCount = await markdownPages.count();
  const markdownStageOrientation = await documentStage.getAttribute(
    "data-source-orientation",
  );
  assert(
    markdownStageOrientation === "portrait",
    `Markdown portrait setting was not applied: ${markdownStageOrientation}`,
  );
  const markdownPageOne = await canvasStats(baseCanvas);
  await markdownPages.nth(1).click();
  await page.waitForFunction(
    () =>
      document
        .querySelectorAll(".source-rail__page-button")[1]
        ?.getAttribute("aria-current") === "page",
  );
  await page.waitForTimeout(250);
  const markdownPageTwo = await canvasStats(baseCanvas);
  assert(
    markdownPageOne.hash !== markdownPageTwo.hash,
    "Markdown page navigation did not change the rendered source frame.",
  );

  await clickDocumentToolbar(page, '.document-toolbar__tool[data-tool="pen"]');
  await drawGesture(page, transientCanvas, {
    startX: 0.36,
    startY: 0.38,
    endX: 0.62,
    endY: 0.5,
    steps: 14,
  });
  await page.mouse.up();
  await page.waitForFunction(() => {
    const canvas = document.querySelector(
      ".document-stage__canvas--committed",
    );
    if (!(canvas instanceof HTMLCanvasElement)) return false;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    return Boolean(
      context?.getImageData(0, 0, canvas.width, canvas.height).data.some(
        (value, index) => index % 4 === 3 && value > 10,
      ),
    );
  });
  const markdownAnnotation = await canvasStats(committedCanvas);
  await page.waitForTimeout(900);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(
    () =>
      document.querySelector(".app-shell")?.getAttribute("data-content-source") ===
        "markdown" &&
      document
        .querySelectorAll(".source-rail__page-button")[1]
        ?.getAttribute("aria-current") === "page",
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(350);
  const reloadedMarkdownAnnotation = await canvasStats(committedCanvas);
  assert(
    markdownAnnotation.alphaPixels > 100 &&
      reloadedMarkdownAnnotation.alphaPixels > 100,
    "Markdown page annotation did not survive a real application reload.",
  );
  const markdownProjectSource = await page.evaluate(async () => {
    const store = await import("/src/core/projectStore.ts");
    const project = await store.loadCurrentCourseProject();
    return project?.sources.find((source) => source.assetFormat === "markdown") ?? null;
  });
  assert(
    markdownProjectSource?.renderEngine === "markdown" &&
      markdownProjectSource?.currentPageIndex === 1 &&
      markdownProjectSource?.presentation?.mode === "document" &&
      markdownProjectSource?.presentation?.orientation === "portrait" &&
      markdownProjectSource?.presentation?.theme === "warm",
    `Markdown project metadata was not persisted: ${JSON.stringify(markdownProjectSource)}`,
  );

  await page.locator(".source-rail__whiteboard-button").click();
  await page.waitForFunction(
    () =>
      document.querySelector(".app-shell")?.getAttribute("data-content-source") ===
      "whiteboard",
  );

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
        productKernel,
        image: {
          source: imageSourceAtLoad,
          canvasLayers: imageCanvasLayers,
          base: imageBaseStats,
          committedPenPixels: committedAfterPen.alphaPixels,
          annotationReachedOutput: outputWithAnnotation !== outputAfterUndo,
          annotationCoordinateSpace: {
            contain: containAnnotationBounds,
            cover: coverAnnotationBounds,
            restoredContain: restoredContainBounds,
          },
          laser: laserDuringGesture,
        },
        pdf: {
          pages: 2,
          pageOneHash: pdfPageOneStats.hash,
          pageTwoHash: pdfPageTwoStats.hash,
          pageOneAnnotationPixels: pdfPageOneAnnotation.alphaPixels,
          pageTwoAnnotationPixels: pdfPageTwoAnnotation.alphaPixels,
          restoredPageOneAnnotationPixels: restoredPageOneAnnotation.alphaPixels,
          reloadedPageOneAnnotationPixels: reloadedPageOneAnnotation.alphaPixels,
        },
        markdown: {
          pages: markdownPageCount,
          pageOneHash: markdownPageOne.hash,
          pageTwoHash: markdownPageTwo.hash,
          annotationPixels: markdownAnnotation.alphaPixels,
          reloadedAnnotationPixels: reloadedMarkdownAnnotation.alphaPixels,
          projectRenderEngine: markdownProjectSource.renderEngine,
        },
        staticHtml: {
          pages: htmlPageCount,
          pageOneHash: htmlPageOne.hash,
          redPixels: htmlPageOne.redPixels,
          greenPixels: htmlPageOne.greenPixels,
          scriptExecuted: false,
          projectRenderEngine: htmlProjectSource.renderEngine,
        },
        returnedToWhiteboard: true,
        screenshotPath,
        externalRequests: externalRequests.length,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
