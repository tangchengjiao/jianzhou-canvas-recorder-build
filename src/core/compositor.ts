import { CameraPlanner, type CameraSnapshot } from "./cameraPlanner";
import {
  captureRegionToPixels,
  clampCaptureRegion,
  drawCanvasStyle,
  getCanvasStyleMetadata,
  type CanvasStyle,
  type CaptureRegion,
} from "./outputProfile";

export type CursorPosition = {
  x: number;
  y: number;
  visible: boolean;
};

export type WebcamShape = "circle" | "square";
export type WebcamSize = "small" | "medium" | "large";
export type WebcamPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export type WebcamPlacement = {
  /** Center point in normalized output coordinates. */
  x: number;
  y: number;
};

export type WebcamOverlayConfig = {
  enabled: boolean;
  shape: WebcamShape;
  size: WebcamSize;
  position: WebcamPosition;
  placement: WebcamPlacement | null;
  mirror: boolean;
};

export type CompositorStats = {
  renderedFrames: number;
  skippedSourceFrames: number;
  stableSceneCommits: number;
  overlayFrames: number;
  overlayPendingClear: boolean;
  drawingActive: boolean;
  drawingGestures: number;
  targetFps: number;
  previewActive: boolean;
  recordingActive: boolean;
  outputWidth: number;
  outputHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  cameraPhase: CameraSnapshot["phase"];
  cameraZoom: number;
  maxCameraZoom: number;
  laserInputPoints: number;
  laserDrawnFrames: number;
  webcamReady: boolean;
  webcamDrawnFrames: number;
  webcamSkippedFrames: number;
  lastWebcamDrawAt: number | null;
  canvasStyle: CanvasStyle;
  captureRegion: CaptureRegion | null;
};

/**
 * A presentation source expressed as one or more same-sized canvas layers.
 * Stable layers are committed into the scene buffer in order. The optional
 * transient layer is sampled while a gesture is active so freshly drawn
 * strokes never disappear between the live and committed frames.
 */
export type SceneSourceFrame = {
  id: string;
  kind:
    | "excalidraw"
    | "image"
    | "pdf"
    | "markdown"
    | "html"
    | "html-capture";
  revision: number;
  width: number;
  height: number;
  backgroundColor?: string;
  stableLayers: readonly HTMLCanvasElement[];
  transientLayer?: HTMLCanvasElement | null;
};

export type SceneSourceFrameProvider = () => SceneSourceFrame | null;

type CropRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
};

type BoardRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
};

type LaserTrailPoint = {
  x: number;
  y: number;
  at: number;
};

type LaserTrail = {
  points: LaserTrailPoint[];
  active: boolean;
};

const IDLE_FPS = 12;
const PREVIEW_FPS = 24;
const RECORDING_FPS = 30;
const SCENE_SETTLE_MS = 72;
const LASER_TRAIL_LIFETIME_MS = 1_000;
const MAX_LASER_TRAIL_POINTS = 360;
const MIN_LASER_POINT_DISTANCE = 0.0008;

const DEFAULT_WEBCAM_CONFIG: WebcamOverlayConfig = {
  enabled: false,
  shape: "circle",
  size: "medium",
  position: "bottom-right",
  placement: null,
  mirror: true,
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const createCanvas = () => document.createElement("canvas");

const resizeCanvas = (
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
) => {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
};

const getBaseCrop = (
  sourceWidth: number,
  sourceHeight: number,
  targetAspect: number,
): CropRect => {
  const sourceAspect = sourceWidth / sourceHeight;
  let width = sourceWidth;
  let height = sourceHeight;

  if (sourceAspect > targetAspect) {
    width = sourceHeight * targetAspect;
  } else {
    height = sourceWidth / targetAspect;
  }

  return {
    x: (sourceWidth - width) / 2,
    y: (sourceHeight - height) / 2,
    width,
    height,
    sourceWidth,
    sourceHeight,
  };
};

const fitCropInsideRegion = (
  region: { x: number; y: number; width: number; height: number },
  targetAspect: number,
  sourceWidth: number,
  sourceHeight: number,
): CropRect => {
  const safeTargetAspect = Math.max(0.01, targetAspect);
  const regionAspect = region.width / Math.max(1, region.height);
  let width = region.width;
  let height = region.height;

  if (regionAspect > safeTargetAspect) {
    width = height * safeTargetAspect;
  } else if (regionAspect < safeTargetAspect) {
    height = width / safeTargetAspect;
  }

  return {
    x: region.x + (region.width - width) / 2,
    y: region.y + (region.height - height) / 2,
    width,
    height,
    sourceWidth,
    sourceHeight,
  };
};

export const findSceneCanvases = (
  root: HTMLElement | null,
): HTMLCanvasElement[] => {
  if (!root) return [];

  const canvases = [
    root.querySelector<HTMLCanvasElement>("canvas.excalidraw__canvas.static"),
    root.querySelector<HTMLCanvasElement>(
      "canvas.excalidraw__canvas.interactive",
    ),
  ].filter(
    (canvas): canvas is HTMLCanvasElement =>
      Boolean(canvas && canvas.width >= 300 && canvas.height >= 200),
  );

  if (canvases.length > 0) return canvases;

  return Array.from(root.querySelectorAll("canvas"))
    .filter((canvas) => canvas.width >= 300 && canvas.height >= 200)
    .sort(
      (left, right) =>
        right.width * right.height - left.width * left.height,
    );
};

export const findSceneCanvas = (
  root: HTMLElement | null,
): HTMLCanvasElement | null => {
  const canvases = findSceneCanvases(root);
  return canvases[1] ?? canvases[0] ?? null;
};

export const getExcalidrawSourceFrame = (
  root: HTMLElement | null,
): SceneSourceFrame | null => {
  const canvases = findSceneCanvases(root);
  const staticCanvas = canvases.find((canvas) =>
    canvas.classList.contains("static"),
  );
  const interactiveCanvas = canvases.find((canvas) =>
    canvas.classList.contains("interactive"),
  );

  if (
    !staticCanvas ||
    !interactiveCanvas ||
    staticCanvas.width !== interactiveCanvas.width ||
    staticCanvas.height !== interactiveCanvas.height
  ) {
    return null;
  }

  return {
    id: "excalidraw:current",
    kind: "excalidraw",
    revision: 0,
    width: staticCanvas.width,
    height: staticCanvas.height,
    backgroundColor: "#ffffff",
    stableLayers: [staticCanvas],
    transientLayer: interactiveCanvas,
  };
};

export class RecordingCompositor {
  private readonly outputContext: CanvasRenderingContext2D | null;
  private readonly workCanvas = createCanvas();
  private readonly workContext: CanvasRenderingContext2D | null;
  private readonly backgroundCanvas = createCanvas();
  private readonly backgroundContext: CanvasRenderingContext2D | null;
  private readonly sceneCanvases = [createCanvas(), createCanvas()] as const;
  private readonly sceneContexts: readonly (
    | CanvasRenderingContext2D
    | null
  )[];
  private readonly overlayCanvas = createCanvas();
  private readonly overlayContext: CanvasRenderingContext2D | null;

  private frameId: number | null = null;
  private lastFrameAt = performance.now();
  private lastDiagnosticsAt = 0;
  private targetFps = IDLE_FPS;
  private previewActive = false;
  private recordingActive = false;
  private activeSceneIndex = 0;
  private hasStableScene = false;
  private sceneDirtyAt = performance.now();
  private sceneBackground = "#ffffff";
  private drawingActive = false;
  private overlayPendingClear = false;
  private hasOverlayFrame = false;
  private sourceCrop: CropRect | null = null;
  private captureRegion: CaptureRegion | null = null;
  private canvasStyle: CanvasStyle = "clean-white";
  private cursor: CursorPosition = { x: 0.5, y: 0.5, visible: false };
  private laserTrails: LaserTrail[] = [];
  private activeLaserTrail: LaserTrail | null = null;
  private webcam: HTMLVideoElement | null = null;
  private frameCommitListener: (() => void) | null = null;
  private webcamConfig = DEFAULT_WEBCAM_CONFIG;
  private renderedFrames = 0;
  private skippedSourceFrames = 0;
  private stableSceneCommits = 0;
  private overlayFrames = 0;
  private drawingGestures = 0;
  private sourceWidth = 0;
  private sourceHeight = 0;
  private cameraPhase: CameraSnapshot["phase"] = "idle";
  private cameraZoom = 1;
  private maxCameraZoom = 1;
  private laserInputPoints = 0;
  private laserDrawnFrames = 0;
  private webcamReady = false;
  private webcamDrawnFrames = 0;
  private webcamSkippedFrames = 0;
  private lastWebcamDrawAt: number | null = null;
  private lastSourceIdentity = "";
  private lastSourceId = "";

  constructor(
    private readonly output: HTMLCanvasElement,
    private readonly getSourceFrame: SceneSourceFrameProvider,
    private readonly camera: CameraPlanner,
  ) {
    // Keep the output canvas synchronized with Chromium's compositor. The
    // low-latency `desynchronized` hint can expose partially presented GPU
    // surfaces while the canvas is visible or captured, which appears as a
    // full-canvas black/white flash on some Windows graphics stacks.
    this.outputContext = output.getContext("2d", { alpha: false });
    this.workContext = this.workCanvas.getContext("2d", { alpha: false });
    this.backgroundContext = this.backgroundCanvas.getContext("2d", {
      alpha: false,
    });
    this.sceneContexts = this.sceneCanvases.map((canvas) =>
      canvas.getContext("2d", { alpha: false }),
    );
    this.overlayContext = this.overlayCanvas.getContext("2d", { alpha: true });
  }

  start() {
    if (this.frameId !== null) return;
    this.lastFrameAt = performance.now();
    this.sceneDirtyAt = this.lastFrameAt;
    this.frameId = requestAnimationFrame(this.render);
  }

  stop() {
    if (this.frameId !== null) {
      cancelAnimationFrame(this.frameId);
      this.frameId = null;
    }
  }

  setRecordingActive(active: boolean) {
    this.recordingActive = active;
    this.updateTargetFps();
  }

  setPreviewActive(active: boolean) {
    this.previewActive = active;
    this.updateTargetFps();
  }

  requestSceneRefresh(backgroundColor?: string) {
    if (backgroundColor) this.sceneBackground = backgroundColor;
    this.sceneDirtyAt = performance.now();
  }

  setCaptureRegion(region: CaptureRegion | null) {
    this.captureRegion = region ? clampCaptureRegion(region) : null;
    this.sourceCrop = null;
    this.hasStableScene = false;
    this.sceneDirtyAt = performance.now();
    this.clearOverlay();
  }

  setCanvasStyle(style: CanvasStyle) {
    if (style === this.canvasStyle) return;
    this.canvasStyle = style;
    this.renderBackground();
  }

  setDrawingActive(active: boolean) {
    if (active === this.drawingActive) return;
    this.drawingActive = active;
    if (active) {
      this.drawingGestures += 1;
      this.overlayPendingClear = false;
    } else {
      this.sceneDirtyAt = performance.now();
      // Keep the last interactive layer visible until the committed static
      // scene has been copied successfully. Clearing it here creates a short
      // but visible gap where a freshly drawn stroke disappears from both the
      // preview and the captured stream.
      this.overlayPendingClear = this.hasOverlayFrame;
    }
  }

  mapSourcePoint(x: number, y: number) {
    const source = this.readSourceFrame();
    if (!source) return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
    const crop = this.getSourceCrop(source.width, source.height);
    return {
      x: clamp((x * source.width - crop.x) / crop.width, 0, 1),
      y: clamp((y * source.height - crop.y) / crop.height, 0, 1),
    };
  }

  setCursor(x: number, y: number, visible = true) {
    this.cursor = {
      x: clamp(x, 0, 1),
      y: clamp(y, 0, 1),
      visible,
    };
  }

  beginLaserTrail(x: number, y: number, now = performance.now()) {
    if (this.activeLaserTrail) {
      this.endLaserTrail(now);
    }

    const trail: LaserTrail = {
      points: [this.createLaserPoint(x, y, now)],
      active: true,
    };
    this.laserTrails.push(trail);
    this.activeLaserTrail = trail;
    this.laserInputPoints += 1;
    this.pruneLaserTrails(now);
    this.trimLaserTrailPoints();
  }

  appendLaserPoint(x: number, y: number, now = performance.now()) {
    if (!this.activeLaserTrail) {
      this.beginLaserTrail(x, y, now);
      return;
    }

    const point = this.createLaserPoint(x, y, now);
    const points = this.activeLaserTrail.points;
    const previous = points[points.length - 1];
    const distance = Math.hypot(point.x - previous.x, point.y - previous.y);

    if (distance < MIN_LASER_POINT_DISTANCE) {
      previous.x = point.x;
      previous.y = point.y;
      previous.at = point.at;
    } else {
      points.push(point);
    }
    this.laserInputPoints += 1;

    this.pruneLaserTrails(now);
    this.trimLaserTrailPoints();
  }

  endLaserTrail(now = performance.now()) {
    const trail = this.activeLaserTrail;
    if (!trail) return;

    trail.active = false;
    const lastPoint = trail.points[trail.points.length - 1];
    if (lastPoint) lastPoint.at = now;
    this.activeLaserTrail = null;
    this.pruneLaserTrails(now);
  }

  clearLaserTrail() {
    this.laserTrails = [];
    this.activeLaserTrail = null;
  }

  setWebcamSource(video: HTMLVideoElement | null) {
    this.webcam = video;
    if (!video) this.webcamReady = false;
  }

  setWebcamConfig(config: Partial<WebcamOverlayConfig>) {
    const nextPlacement =
      config.placement === undefined
        ? this.webcamConfig.placement
        : config.placement
          ? {
              x: clamp(config.placement.x, 0, 1),
              y: clamp(config.placement.y, 0, 1),
            }
          : null;
    this.webcamConfig = {
      ...this.webcamConfig,
      ...config,
      placement: nextPlacement,
    };
    if (!this.webcamConfig.enabled) this.webcamReady = false;
  }

  setFrameCommitListener(listener: (() => void) | null) {
    this.frameCommitListener = listener;
  }

  resetSessionStats() {
    this.renderedFrames = 0;
    this.skippedSourceFrames = 0;
    this.stableSceneCommits = 0;
    this.overlayFrames = 0;
    this.drawingGestures = 0;
    this.maxCameraZoom = this.cameraZoom;
    this.webcamDrawnFrames = 0;
    this.webcamSkippedFrames = 0;
    this.lastWebcamDrawAt = null;
    this.laserInputPoints = 0;
    this.laserDrawnFrames = 0;
    this.clearLaserTrail();
  }

  getStats(): CompositorStats {
    return {
      renderedFrames: this.renderedFrames,
      skippedSourceFrames: this.skippedSourceFrames,
      stableSceneCommits: this.stableSceneCommits,
      overlayFrames: this.overlayFrames,
      overlayPendingClear: this.overlayPendingClear,
      drawingActive: this.drawingActive,
      drawingGestures: this.drawingGestures,
      targetFps: this.targetFps,
      previewActive: this.previewActive,
      recordingActive: this.recordingActive,
      outputWidth: this.output.width,
      outputHeight: this.output.height,
      sourceWidth: this.sourceWidth,
      sourceHeight: this.sourceHeight,
      cameraPhase: this.cameraPhase,
      cameraZoom: this.cameraZoom,
      maxCameraZoom: this.maxCameraZoom,
      laserInputPoints: this.laserInputPoints,
      laserDrawnFrames: this.laserDrawnFrames,
      webcamReady: this.webcamReady,
      webcamDrawnFrames: this.webcamDrawnFrames,
      webcamSkippedFrames: this.webcamSkippedFrames,
      lastWebcamDrawAt: this.lastWebcamDrawAt,
      canvasStyle: this.canvasStyle,
      captureRegion: this.captureRegion ? { ...this.captureRegion } : null,
    };
  }

  private readonly render = (now: number) => {
    this.frameId = requestAnimationFrame(this.render);

    const frameInterval = 1_000 / this.targetFps;
    const elapsed = now - this.lastFrameAt;
    if (elapsed < frameInterval) return;

    const deltaMs = Math.min(100, elapsed);
    this.lastFrameAt = now - (elapsed % frameInterval);
    this.ensureBufferSize();

    const source = this.readSourceFrame();
    if (source) {
      const identity = `${source.id}:${source.revision}:${source.width}x${source.height}`;
      if (identity !== this.lastSourceIdentity) {
        const sourceChanged = source.id !== this.lastSourceId;
        this.lastSourceIdentity = identity;
        this.lastSourceId = source.id;
        this.sceneDirtyAt = now;
        if (sourceChanged) {
          this.hasStableScene = false;
          this.clearOverlay();
        }
      }
    }

    if (
      !this.drawingActive &&
      now - this.sceneDirtyAt >= SCENE_SETTLE_MS
    ) {
      this.refreshStableScene(source);
    }
    if (this.drawingActive) this.refreshInteractiveOverlay(source);

    const camera = this.camera.tick(now, deltaMs);
    this.cameraPhase = camera.phase;
    this.cameraZoom = camera.zoom;
    this.maxCameraZoom = Math.max(this.maxCameraZoom, camera.zoom);
    this.drawCompleteFrame(camera, now);
    this.commitFrame();
    this.renderedFrames += 1;
    this.updateDiagnostics(now, camera);
  };

  private ensureBufferSize() {
    const width = Math.max(1, this.output.width);
    const height = Math.max(1, this.output.height);
    const sizeChanged =
      this.workCanvas.width !== width || this.workCanvas.height !== height;
    if (!sizeChanged) return;

    resizeCanvas(this.workCanvas, width, height);
    resizeCanvas(this.backgroundCanvas, width, height);
    resizeCanvas(this.overlayCanvas, width, height);
    this.sceneCanvases.forEach((canvas) => resizeCanvas(canvas, width, height));
    this.hasStableScene = false;
    this.sceneDirtyAt = performance.now();
    this.clearOverlay();
    this.renderBackground();
  }

  private renderBackground() {
    const context = this.backgroundContext;
    if (!context) return;
    const { width, height } = this.backgroundCanvas;
    const board = this.getBoardRect(width, height);

    drawCanvasStyle(context, width, height, this.canvasStyle);

    context.save();
    context.shadowColor = "rgba(40, 34, 62, 0.2)";
    context.shadowBlur = Math.max(14, width * 0.018);
    context.shadowOffsetY = Math.max(5, height * 0.01);
    context.fillStyle = getCanvasStyleMetadata(this.canvasStyle).boardColor;
    context.beginPath();
    context.roundRect(
      board.x,
      board.y,
      board.width,
      board.height,
      board.radius,
    );
    context.fill();
    context.restore();
  }

  private refreshStableScene(source = this.readSourceFrame()) {
    if (!source) {
      this.skippedSourceFrames += 1;
      return;
    }

    const nextIndex = this.activeSceneIndex === 0 ? 1 : 0;
    const target = this.sceneCanvases[nextIndex];
    const context = this.sceneContexts[nextIndex];
    if (!context) return;

    const crop = this.getSourceCrop(source.width, source.height);
    context.fillStyle = source.backgroundColor ?? this.sceneBackground;
    context.fillRect(0, 0, target.width, target.height);
    try {
      for (const layer of source.stableLayers) {
        context.drawImage(
          layer,
          crop.x,
          crop.y,
          crop.width,
          crop.height,
          0,
          0,
          target.width,
          target.height,
        );
      }
    } catch {
      this.skippedSourceFrames += 1;
      return;
    }

    this.activeSceneIndex = nextIndex;
    this.hasStableScene = true;
    this.sourceCrop = crop;
    this.sourceWidth = source.width;
    this.sourceHeight = source.height;
    this.sceneDirtyAt = Number.POSITIVE_INFINITY;
    this.stableSceneCommits += 1;
    if (this.overlayPendingClear && !this.drawingActive) {
      this.clearOverlay();
    }
  }

  private refreshInteractiveOverlay(source = this.readSourceFrame()) {
    const context = this.overlayContext;
    const interactiveCanvas = source?.transientLayer;
    if (!source || !interactiveCanvas || !context) {
      this.skippedSourceFrames += 1;
      return;
    }

    const crop = this.getSourceCrop(source.width, source.height);
    context.save();
    try {
      // `copy` replaces the complete destination (including transparent
      // pixels) without clearing the previous overlay first. If drawImage
      // fails because Chromium is swapping a GPU surface, the last complete
      // overlay remains available instead of flashing blank.
      context.globalCompositeOperation = "copy";
      context.drawImage(
        interactiveCanvas,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        this.overlayCanvas.width,
        this.overlayCanvas.height,
      );
      this.hasOverlayFrame = true;
      this.overlayFrames += 1;
    } catch {
      this.skippedSourceFrames += 1;
    } finally {
      context.restore();
    }
  }

  private clearOverlay() {
    this.overlayContext?.clearRect(
      0,
      0,
      this.overlayCanvas.width,
      this.overlayCanvas.height,
    );
    this.hasOverlayFrame = false;
    this.overlayPendingClear = false;
  }

  private readSourceFrame(): SceneSourceFrame | null {
    const source = this.getSourceFrame();
    if (
      !source ||
      source.width < 1 ||
      source.height < 1 ||
      source.stableLayers.length === 0 ||
      source.stableLayers.some(
        (layer) =>
          layer.width !== source.width || layer.height !== source.height,
      ) ||
      (source.transientLayer &&
        (source.transientLayer.width !== source.width ||
          source.transientLayer.height !== source.height))
    ) {
      return null;
    }
    return source;
  }

  private drawCompleteFrame(camera: CameraSnapshot, now: number) {
    const context = this.workContext;
    if (!context) return;
    const width = this.workCanvas.width;
    const height = this.workCanvas.height;
    const board = this.getBoardRect(width, height);

    context.drawImage(this.backgroundCanvas, 0, 0);
    context.save();
    context.beginPath();
    context.roundRect(
      board.x,
      board.y,
      board.width,
      board.height,
      board.radius,
    );
    context.clip();
    context.fillStyle = this.sceneBackground;
    context.fillRect(board.x, board.y, board.width, board.height);

    if (this.hasStableScene) {
      const scene = this.sceneCanvases[this.activeSceneIndex];
      const crop = this.getCameraCrop(scene, camera);
      context.drawImage(
        scene,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        board.x,
        board.y,
        board.width,
        board.height,
      );
      if (this.drawingActive || this.overlayPendingClear) {
        context.drawImage(
          this.overlayCanvas,
          crop.x,
          crop.y,
          crop.width,
          crop.height,
          board.x,
          board.y,
          board.width,
          board.height,
        );
      }
      this.drawLaserTrails(context, crop, board, now);
      this.drawCursor(context, crop, board);
    } else {
      context.fillStyle = "#8f8a9c";
      context.font = `600 ${Math.max(18, width * 0.018)}px system-ui, sans-serif`;
      context.textAlign = "center";
      context.fillText("正在连接 Excalidraw 画布…", width / 2, height / 2);
    }
    context.restore();

    this.drawWebcam(context, width, height, now);
  }

  private commitFrame() {
    if (!this.outputContext) return;
    this.outputContext.drawImage(this.workCanvas, 0, 0);
    this.frameCommitListener?.();
  }

  private getCameraCrop(
    source: HTMLCanvasElement,
    camera: CameraSnapshot,
  ): CropRect {
    const width = source.width / camera.zoom;
    const height = source.height / camera.zoom;
    const centerX = camera.focusX * source.width;
    const centerY = camera.focusY * source.height;
    return {
      x: clamp(centerX - width / 2, 0, source.width - width),
      y: clamp(centerY - height / 2, 0, source.height - height),
      width,
      height,
      sourceWidth: source.width,
      sourceHeight: source.height,
    };
  }

  private getSourceCrop(sourceWidth: number, sourceHeight: number): CropRect {
    if (!this.captureRegion) {
      return getBaseCrop(
        sourceWidth,
        sourceHeight,
        Math.max(0.01, this.output.width / Math.max(1, this.output.height)),
      );
    }

    const region = captureRegionToPixels(
      this.captureRegion,
      sourceWidth,
      sourceHeight,
    );
    return fitCropInsideRegion(
      region,
      Math.max(0.01, this.output.width / Math.max(1, this.output.height)),
      sourceWidth,
      sourceHeight,
    );
  }

  private drawCursor(
    context: CanvasRenderingContext2D,
    crop: CropRect,
    board: BoardRect,
  ) {
    if (!this.cursor.visible) return;

    const { x, y } = this.mapNormalizedPointToBoard(
      this.cursor,
      crop,
      board,
    );
    if (
      x < board.x ||
      x > board.x + board.width ||
      y < board.y ||
      y > board.y + board.height
    ) {
      return;
    }

    const radius = Math.max(10, this.workCanvas.width * 0.0115);
    context.save();
    context.fillStyle = "rgba(255, 75, 91, 0.32)";
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = "rgba(255, 75, 91, 0.9)";
    context.lineWidth = Math.max(2, this.workCanvas.width * 0.0015);
    context.stroke();
    context.restore();
  }

  private drawLaserTrails(
    context: CanvasRenderingContext2D,
    crop: CropRect,
    board: BoardRect,
    now: number,
  ) {
    this.pruneLaserTrails(now);
    if (this.laserTrails.length === 0) return;
    this.laserDrawnFrames += 1;

    const lineWidth = Math.max(4, this.workCanvas.width * 0.0042);
    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = lineWidth;
    context.shadowColor = "rgba(255, 43, 72, 0.58)";
    context.shadowBlur = Math.max(5, lineWidth * 1.35);

    for (const trail of this.laserTrails) {
      const points = trail.points;
      for (let index = 1; index < points.length; index += 1) {
        const point = points[index];
        const alpha = this.getLaserPointAlpha(
          point,
          trail.active && index === points.length - 1,
          now,
        );
        if (alpha <= 0) continue;

        const previous = this.mapNormalizedPointToBoard(
          points[index - 1],
          crop,
          board,
        );
        const current = this.mapNormalizedPointToBoard(point, crop, board);
        context.strokeStyle = `rgba(255, 45, 72, ${0.18 + alpha * 0.82})`;
        context.beginPath();
        context.moveTo(previous.x, previous.y);
        context.lineTo(current.x, current.y);
        context.stroke();
      }

      const head = points[points.length - 1];
      if (!head) continue;
      const headAlpha = this.getLaserPointAlpha(head, trail.active, now);
      if (headAlpha <= 0) continue;

      const headPosition = this.mapNormalizedPointToBoard(head, crop, board);
      const headRadius = Math.max(3, lineWidth * 0.72);
      context.fillStyle = `rgba(255, 42, 70, ${headAlpha})`;
      context.beginPath();
      context.arc(
        headPosition.x,
        headPosition.y,
        headRadius,
        0,
        Math.PI * 2,
      );
      context.fill();

      context.shadowBlur = 0;
      context.fillStyle = `rgba(255, 232, 236, ${headAlpha * 0.92})`;
      context.beginPath();
      context.arc(
        headPosition.x,
        headPosition.y,
        Math.max(1.5, headRadius * 0.34),
        0,
        Math.PI * 2,
      );
      context.fill();
      context.shadowBlur = Math.max(5, lineWidth * 1.35);
    }

    context.restore();
  }

  private createLaserPoint(
    x: number,
    y: number,
    at: number,
  ): LaserTrailPoint {
    return {
      x: clamp(x, 0, 1),
      y: clamp(y, 0, 1),
      at,
    };
  }

  private getLaserPointAlpha(
    point: LaserTrailPoint,
    activeHead: boolean,
    now: number,
  ) {
    if (activeHead) return 1;
    const remaining = clamp(
      1 - (now - point.at) / LASER_TRAIL_LIFETIME_MS,
      0,
      1,
    );
    return 1 - Math.pow(1 - remaining, 3);
  }

  private pruneLaserTrails(now: number) {
    const cutoff = now - LASER_TRAIL_LIFETIME_MS;

    for (const trail of this.laserTrails) {
      const firstFreshIndex = trail.points.findIndex(
        (point) => point.at >= cutoff,
      );

      if (firstFreshIndex === -1) {
        if (trail.active && trail.points.length > 0) {
          trail.points.splice(0, trail.points.length - 1);
        } else {
          trail.points.length = 0;
        }
      } else if (firstFreshIndex > 1) {
        // Keep one expired point as an invisible anchor so the first visible
        // segment enters the fading tail without a discontinuity.
        trail.points.splice(0, firstFreshIndex - 1);
      }
    }

    this.laserTrails = this.laserTrails.filter(
      (trail) => trail.active || trail.points.length > 0,
    );
  }

  private trimLaserTrailPoints() {
    let overflow =
      this.laserTrails.reduce(
        (total, trail) => total + trail.points.length,
        0,
      ) - MAX_LASER_TRAIL_POINTS;
    if (overflow <= 0) return;

    for (const trail of this.laserTrails) {
      if (overflow <= 0) break;
      const minimumPoints = trail.active ? 1 : 0;
      const removeCount = Math.min(
        overflow,
        Math.max(0, trail.points.length - minimumPoints),
      );
      if (removeCount > 0) {
        trail.points.splice(0, removeCount);
        overflow -= removeCount;
      }
    }

    this.laserTrails = this.laserTrails.filter(
      (trail) => trail.active || trail.points.length > 0,
    );
  }

  private mapNormalizedPointToBoard(
    point: Pick<LaserTrailPoint, "x" | "y">,
    crop: CropRect,
    board: BoardRect,
  ) {
    const sourceX = point.x * crop.sourceWidth;
    const sourceY = point.y * crop.sourceHeight;
    return {
      x: board.x + ((sourceX - crop.x) / crop.width) * board.width,
      y: board.y + ((sourceY - crop.y) / crop.height) * board.height,
    };
  }

  private drawWebcam(
    context: CanvasRenderingContext2D,
    outputWidth: number,
    outputHeight: number,
    _now: number,
  ) {
    const video = this.webcam;
    const config = this.webcamConfig;
    if (
      !config.enabled ||
      !video ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      video.videoWidth <= 0 ||
      video.videoHeight <= 0
    ) {
      this.webcamReady = false;
      if (config.enabled) this.webcamSkippedFrames += 1;
      return;
    }
    this.webcamReady = true;

    const sizeRatio = { small: 0.14, medium: 0.19, large: 0.26 }[
      config.size
    ];
    const shortEdge = Math.min(outputWidth, outputHeight);
    const size = shortEdge * sizeRatio;
    const margin = shortEdge * 0.055;
    const left = config.position.endsWith("left");
    const top = config.position.startsWith("top");
    const x = config.placement
      ? clamp(
          config.placement.x * outputWidth - size / 2,
          margin,
          outputWidth - size - margin,
        )
      : left
        ? margin
        : outputWidth - size - margin;
    const y = config.placement
      ? clamp(
          config.placement.y * outputHeight - size / 2,
          margin,
          outputHeight - size - margin,
        )
      : top
        ? margin
        : outputHeight - size - margin;

    const sourceSize = Math.min(video.videoWidth, video.videoHeight);
    const sourceX = (video.videoWidth - sourceSize) / 2;
    const sourceY = (video.videoHeight - sourceSize) / 2;

    context.save();
    context.beginPath();
    if (config.shape === "circle") {
      context.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    } else {
      context.roundRect(x, y, size, size, Math.max(12, size * 0.1));
    }
    context.clip();

    try {
      if (config.mirror) {
        context.translate(x + size, y);
        context.scale(-1, 1);
        context.drawImage(
          video,
          sourceX,
          sourceY,
          sourceSize,
          sourceSize,
          0,
          0,
          size,
          size,
        );
      } else {
        context.drawImage(
          video,
          sourceX,
          sourceY,
          sourceSize,
          sourceSize,
          x,
          y,
          size,
          size,
        );
      }
    } catch {
      context.restore();
      this.webcamReady = false;
      this.webcamSkippedFrames += 1;
      return;
    }
    context.restore();
    this.webcamDrawnFrames += 1;
    this.lastWebcamDrawAt = Date.now();

    context.save();
    context.strokeStyle = "rgba(255, 255, 255, 0.94)";
    context.lineWidth = Math.max(4, outputHeight * 0.006);
    context.beginPath();
    if (config.shape === "circle") {
      context.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
    } else {
      context.roundRect(x, y, size, size, Math.max(12, size * 0.1));
    }
    context.stroke();
    context.restore();
  }

  private getBoardRect(width: number, height: number): BoardRect {
    const horizontalMargin = Math.max(24, width * 0.028);
    const targetAspect = width / Math.max(1, height);
    let boardWidth = width - horizontalMargin * 2;
    let boardHeight = boardWidth / targetAspect;
    const maxHeight = height - Math.max(24, height * 0.05);
    if (boardHeight > maxHeight) {
      boardHeight = maxHeight;
      boardWidth = boardHeight * targetAspect;
    }
    return {
      x: (width - boardWidth) / 2,
      y: (height - boardHeight) / 2,
      width: boardWidth,
      height: boardHeight,
      radius: Math.max(14, width * 0.014),
    };
  }

  private updateDiagnostics(now: number, camera: CameraSnapshot) {
    if (now - this.lastDiagnosticsAt < 200) return;
    this.lastDiagnosticsAt = now;
    this.output.dataset.cameraPhase = camera.phase;
    this.output.dataset.cameraZoom = camera.zoom.toFixed(3);
    this.output.dataset.compositorFps = this.targetFps.toString();
    this.output.dataset.sourceReady = this.hasStableScene ? "true" : "false";
    this.output.dataset.previewActive = this.previewActive ? "true" : "false";
    this.output.dataset.recordingActive = this.recordingActive
      ? "true"
      : "false";
    this.output.dataset.drawingActive = this.drawingActive ? "true" : "false";
    this.output.dataset.drawingGestures = this.drawingGestures.toString();
    this.output.dataset.stableSceneCommits =
      this.stableSceneCommits.toString();
    this.output.dataset.overlayFrames = this.overlayFrames.toString();
    this.output.dataset.overlayPendingClear = this.overlayPendingClear
      ? "true"
      : "false";
    this.output.dataset.maxCameraZoom = this.maxCameraZoom.toFixed(3);
    this.output.dataset.laserInputPoints = this.laserInputPoints.toString();
    this.output.dataset.laserDrawnFrames = this.laserDrawnFrames.toString();
    this.output.dataset.webcamReady = this.webcamReady ? "true" : "false";
    this.output.dataset.webcamDrawnFrames =
      this.webcamDrawnFrames.toString();
    this.output.dataset.webcamSkippedFrames =
      this.webcamSkippedFrames.toString();
    this.output.dataset.webcamPlacementMode = this.webcamConfig.placement
      ? "custom"
      : this.webcamConfig.position;
    if (this.webcamConfig.placement) {
      this.output.dataset.webcamPlacementX =
        this.webcamConfig.placement.x.toFixed(4);
      this.output.dataset.webcamPlacementY =
        this.webcamConfig.placement.y.toFixed(4);
    } else {
      delete this.output.dataset.webcamPlacementX;
      delete this.output.dataset.webcamPlacementY;
    }
    if (this.lastWebcamDrawAt === null) {
      delete this.output.dataset.lastWebcamDrawAt;
    } else {
      this.output.dataset.lastWebcamDrawAt =
        this.lastWebcamDrawAt.toString();
    }
  }

  private updateTargetFps() {
    const nextTargetFps = this.recordingActive
      ? RECORDING_FPS
      : this.previewActive
        ? PREVIEW_FPS
        : IDLE_FPS;
    if (nextTargetFps === this.targetFps) return;
    this.targetFps = nextTargetFps;
    this.lastFrameAt = performance.now() - 1_000 / this.targetFps;
  }
}
