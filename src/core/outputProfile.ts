export type AspectPresetId = "16:9" | "4:3" | "3:4" | "9:16" | "1:1";

export type CustomAspectChoice = {
  id: "custom";
  /** Ratio width, not a pixel dimension. */
  width: number;
  /** Ratio height, not a pixel dimension. */
  height: number;
};

export type AspectChoice = AspectPresetId | CustomAspectChoice;
export type OutputResolution = "720p" | "1080p";

export type CanvasStyle =
  | "clean-white"
  | "soft-light"
  | "sea-salt-blue"
  | "warm-day"
  | "graphite";

/** A rectangle expressed relative to the source canvas (0..1). */
export type CaptureRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type OutputProfile = {
  aspect: AspectChoice;
  resolution: OutputResolution;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  style: CanvasStyle;
  captureRegion: CaptureRegion;
};

export type AspectPresetMetadata = {
  id: AspectPresetId;
  label: string;
  hint: string;
  width: number;
  height: number;
};

export type CanvasStyleMetadata = {
  id: CanvasStyle;
  label: string;
  description: string;
  /** CSS background used by small UI swatches; the compositor uses drawCanvasStyle. */
  preview: string;
  boardColor: string;
  foregroundColor: string;
  dark: boolean;
};

export type OutputResolutionMetadata = {
  id: OutputResolution;
  label: string;
  shortEdge: number;
  fps: number;
  bitrate: number;
};

export const ASPECT_PRESETS: readonly AspectPresetMetadata[] = [
  { id: "16:9", label: "16:9", hint: "横屏", width: 16, height: 9 },
  { id: "4:3", label: "4:3", hint: "经典", width: 4, height: 3 },
  { id: "3:4", label: "3:4", hint: "小红书", width: 3, height: 4 },
  { id: "9:16", label: "9:16", hint: "竖屏", width: 9, height: 16 },
  { id: "1:1", label: "1:1", hint: "正方形", width: 1, height: 1 },
] as const;

export const OUTPUT_RESOLUTIONS: readonly OutputResolutionMetadata[] = [
  {
    id: "720p",
    label: "稳定 720p",
    shortEdge: 720,
    fps: 30,
    bitrate: 4_000_000,
  },
  {
    id: "1080p",
    label: "高清 1080p",
    shortEdge: 1_080,
    fps: 30,
    bitrate: 6_000_000,
  },
] as const;

export const CANVAS_STYLES: readonly CanvasStyleMetadata[] = [
  {
    id: "clean-white",
    label: "纯净白",
    description: "干净、专注，适合课程与结构化讲解",
    preview: "#f8fafc",
    boardColor: "#ffffff",
    foregroundColor: "#111827",
    dark: false,
  },
  {
    id: "soft-light",
    label: "柔光",
    description: "低饱和紫粉柔光，适合轻松表达",
    preview:
      "radial-gradient(circle at 20% 20%, #f8dff0, transparent 55%), linear-gradient(135deg, #f4f0ff, #e7f7f4)",
    boardColor: "#fffefe",
    foregroundColor: "#1f2937",
    dark: false,
  },
  {
    id: "sea-salt-blue",
    label: "海盐蓝",
    description: "清爽冷调，适合工具演示和知识内容",
    preview: "linear-gradient(145deg, #eef9ff, #c8e7f4)",
    boardColor: "#fbfdff",
    foregroundColor: "#102a43",
    dark: false,
  },
  {
    id: "warm-day",
    label: "暖日",
    description: "奶油暖色，适合故事与生活化内容",
    preview: "linear-gradient(145deg, #fff8e8, #ffdcca)",
    boardColor: "#fffdf8",
    foregroundColor: "#3f2d20",
    dark: false,
  },
  {
    id: "graphite",
    label: "石墨",
    description: "克制深色，适合高对比与夜间录制",
    preview: "linear-gradient(145deg, #30343b, #17191d)",
    boardColor: "#202328",
    foregroundColor: "#f8fafc",
    dark: true,
  },
] as const;

export const DEFAULT_ASPECT_CHOICE: AspectChoice = "16:9";
export const DEFAULT_CANVAS_STYLE: CanvasStyle = "clean-white";
export const DEFAULT_CAPTURE_REGION: Readonly<CaptureRegion> = Object.freeze({
  x: 0,
  y: 0,
  width: 1,
  height: 1,
});

const MIN_REGION_SIZE = 0.02;
const MIN_CUSTOM_RATIO_PART = 1;
const MAX_CUSTOM_RATIO_PART = 10_000;
export const MIN_CUSTOM_ASPECT_RATIO = 1 / 4;
export const MAX_CUSTOM_ASPECT_RATIO = 4;
export const MAX_OUTPUT_DIMENSION = 4_320;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const finiteOr = (value: number, fallback: number) =>
  Number.isFinite(value) ? value : fallback;

const roundEven = (value: number) =>
  Math.max(2, Math.round(finiteOr(value, 2) / 2) * 2);

const greatestCommonDivisor = (left: number, right: number) => {
  let a = Math.max(1, Math.round(Math.abs(left)));
  let b = Math.max(1, Math.round(Math.abs(right)));
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
};

const getPreset = (id: AspectPresetId) => {
  const preset = ASPECT_PRESETS.find((candidate) => candidate.id === id);
  // The union and constant are intentionally maintained together, so this is
  // an invariant failure rather than a recoverable user-input error.
  if (!preset) throw new Error(`Unknown aspect preset: ${id}`);
  return preset;
};

export const createCustomAspect = (
  width: number,
  height: number,
): CustomAspectChoice => {
  let safeWidth = clamp(
    Math.round(finiteOr(width, 16)),
    MIN_CUSTOM_RATIO_PART,
    MAX_CUSTOM_RATIO_PART,
  );
  let safeHeight = clamp(
    Math.round(finiteOr(height, 9)),
    MIN_CUSTOM_RATIO_PART,
    MAX_CUSTOM_RATIO_PART,
  );
  const ratio = safeWidth / safeHeight;

  // Custom ratios are intentionally bounded. The output quality uses the
  // selected short edge, so values such as 1:10000 would otherwise allocate a
  // multi-million-pixel-tall canvas and can crash the renderer before a user
  // ever presses Record.
  if (ratio < MIN_CUSTOM_ASPECT_RATIO) {
    safeWidth = 1;
    safeHeight = Math.round(1 / MIN_CUSTOM_ASPECT_RATIO);
  } else if (ratio > MAX_CUSTOM_ASPECT_RATIO) {
    safeWidth = Math.round(MAX_CUSTOM_ASPECT_RATIO);
    safeHeight = 1;
  } else {
    const divisor = greatestCommonDivisor(safeWidth, safeHeight);
    safeWidth /= divisor;
    safeHeight /= divisor;
  }

  return {
    id: "custom",
    width: safeWidth,
    height: safeHeight,
  };
};

export const getAspectParts = (
  choice: AspectChoice,
): { width: number; height: number } => {
  if (typeof choice === "string") {
    const preset = getPreset(choice);
    return { width: preset.width, height: preset.height };
  }

  const custom = createCustomAspect(choice.width, choice.height);
  return { width: custom.width, height: custom.height };
};

export const getAspectRatio = (choice: AspectChoice) => {
  const { width, height } = getAspectParts(choice);
  return width / height;
};

export const getAspectLabel = (choice: AspectChoice) => {
  if (typeof choice === "string") return choice;
  const { width, height } = getAspectParts(choice);
  return `${width}:${height}`;
};

/**
 * Uses the selected quality as the short edge. This produces familiar values
 * such as 1280x720, 720x1280, 960x720 and 1080x1080. Encoder dimensions are
 * always even, including for custom ratios.
 */
export const getOutputDimensions = (
  aspect: AspectChoice,
  resolution: OutputResolution,
) => {
  const ratio = getAspectRatio(aspect);
  const quality =
    OUTPUT_RESOLUTIONS.find((candidate) => candidate.id === resolution) ??
    OUTPUT_RESOLUTIONS[0];
  const shortEdge = quality.shortEdge;

  if (ratio > 1) {
    return {
      width: Math.min(MAX_OUTPUT_DIMENSION, roundEven(shortEdge * ratio)),
      height: shortEdge,
    };
  }
  if (ratio < 1) {
    return {
      width: shortEdge,
      height: Math.min(MAX_OUTPUT_DIMENSION, roundEven(shortEdge / ratio)),
    };
  }
  return { width: shortEdge, height: shortEdge };
};

export const clampCaptureRegion = (
  region: Partial<CaptureRegion> | null | undefined,
  minimumSize = MIN_REGION_SIZE,
): CaptureRegion => {
  const safeMinimum = clamp(finiteOr(minimumSize, MIN_REGION_SIZE), 0.001, 1);
  const width = clamp(
    finiteOr(region?.width ?? 1, 1),
    safeMinimum,
    1,
  );
  const height = clamp(
    finiteOr(region?.height ?? 1, 1),
    safeMinimum,
    1,
  );

  return {
    x: clamp(finiteOr(region?.x ?? 0, 0), 0, 1 - width),
    y: clamp(finiteOr(region?.y ?? 0, 0), 0, 1 - height),
    width,
    height,
  };
};

export const isDefaultCaptureRegion = (
  region: CaptureRegion,
  epsilon = 0.0001,
) => {
  const safe = clampCaptureRegion(region);
  return (
    Math.abs(safe.x) <= epsilon &&
    Math.abs(safe.y) <= epsilon &&
    Math.abs(safe.width - 1) <= epsilon &&
    Math.abs(safe.height - 1) <= epsilon
  );
};

/** Returns the region's physical aspect ratio within the source canvas. */
export const getCaptureRegionAspectRatio = (
  region: CaptureRegion,
  sourceWidth = 1,
  sourceHeight = 1,
) => {
  const safe = clampCaptureRegion(region);
  const safeSourceWidth = Math.max(1, finiteOr(sourceWidth, 1));
  const safeSourceHeight = Math.max(1, finiteOr(sourceHeight, 1));
  return (
    (safe.width * safeSourceWidth) / (safe.height * safeSourceHeight)
  );
};

/**
 * Builds the largest centered normalized region with the requested aspect.
 * Passing a center allows the same helper to preserve the user's focal area.
 */
export const createCaptureRegionForAspect = (
  aspect: AspectChoice | number,
  sourceWidth: number,
  sourceHeight: number,
  centerX = 0.5,
  centerY = 0.5,
): CaptureRegion => {
  const targetRatio =
    typeof aspect === "number"
      ? Math.max(0.01, finiteOr(aspect, 16 / 9))
      : getAspectRatio(aspect);
  const safeSourceWidth = Math.max(1, finiteOr(sourceWidth, 1));
  const safeSourceHeight = Math.max(1, finiteOr(sourceHeight, 1));
  const sourceRatio = safeSourceWidth / safeSourceHeight;

  let width = 1;
  let height = 1;
  if (sourceRatio > targetRatio) {
    width = targetRatio / sourceRatio;
  } else if (sourceRatio < targetRatio) {
    height = sourceRatio / targetRatio;
  }

  return clampCaptureRegion({
    x: finiteOr(centerX, 0.5) - width / 2,
    y: finiteOr(centerY, 0.5) - height / 2,
    width,
    height,
  });
};

/** Fits a requested aspect inside an existing region while keeping its center. */
export const fitCaptureRegionToAspect = (
  region: CaptureRegion,
  aspect: AspectChoice | number,
  sourceWidth: number,
  sourceHeight: number,
): CaptureRegion => {
  const safe = clampCaptureRegion(region);
  const targetRatio =
    typeof aspect === "number"
      ? Math.max(0.01, finiteOr(aspect, 16 / 9))
      : getAspectRatio(aspect);
  const currentRatio = getCaptureRegionAspectRatio(
    safe,
    sourceWidth,
    sourceHeight,
  );

  let width = safe.width;
  let height = safe.height;
  if (currentRatio > targetRatio) {
    width *= targetRatio / currentRatio;
  } else if (currentRatio < targetRatio) {
    height *= currentRatio / targetRatio;
  }

  return clampCaptureRegion({
    x: safe.x + (safe.width - width) / 2,
    y: safe.y + (safe.height - height) / 2,
    width,
    height,
  });
};

export const captureRegionToPixels = (
  region: CaptureRegion,
  sourceWidth: number,
  sourceHeight: number,
) => {
  const safe = clampCaptureRegion(region);
  const width = Math.max(1, finiteOr(sourceWidth, 1));
  const height = Math.max(1, finiteOr(sourceHeight, 1));
  return {
    x: safe.x * width,
    y: safe.y * height,
    width: safe.width * width,
    height: safe.height * height,
  };
};

export const createOutputProfile = (options?: {
  aspect?: AspectChoice;
  resolution?: OutputResolution;
  style?: CanvasStyle;
  captureRegion?: Partial<CaptureRegion> | null;
}): OutputProfile => {
  const aspect = options?.aspect ?? DEFAULT_ASPECT_CHOICE;
  const resolution = options?.resolution ?? "720p";
  const style = options?.style ?? DEFAULT_CANVAS_STYLE;
  const dimensions = getOutputDimensions(aspect, resolution);
  const quality =
    OUTPUT_RESOLUTIONS.find((candidate) => candidate.id === resolution) ??
    OUTPUT_RESOLUTIONS[0];

  return {
    aspect,
    resolution,
    ...dimensions,
    fps: quality.fps,
    bitrate: quality.bitrate,
    style,
    captureRegion: clampCaptureRegion(options?.captureRegion),
  };
};

export const DEFAULT_OUTPUT_PROFILE: Readonly<OutputProfile> = Object.freeze(
  createOutputProfile(),
);

export const getCanvasStyleMetadata = (style: CanvasStyle) =>
  CANVAS_STYLES.find((candidate) => candidate.id === style) ?? CANVAS_STYLES[0];

const fillLinearGradient = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  start: string,
  end: string,
) => {
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, start);
  gradient.addColorStop(1, end);
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
};

const fillSoftSpot = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  x: number,
  y: number,
  color: string,
) => {
  const radius = Math.max(width, height) * 0.72;
  const gradient = context.createRadialGradient(
    width * x,
    height * y,
    0,
    width * x,
    height * y,
    radius,
  );
  gradient.addColorStop(0, color);
  gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
};

/**
 * Paints only the output background. It deliberately avoids animation and
 * per-pixel work so it is safe to call from a 30fps recording compositor.
 */
export const drawCanvasStyle = (
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  style: CanvasStyle,
) => {
  const safeWidth = Math.max(1, finiteOr(width, 1));
  const safeHeight = Math.max(1, finiteOr(height, 1));

  context.save();
  context.globalAlpha = 1;
  context.globalCompositeOperation = "source-over";

  switch (style) {
    case "soft-light":
      fillLinearGradient(context, safeWidth, safeHeight, "#f7f2ff", "#e7f7f3");
      fillSoftSpot(
        context,
        safeWidth,
        safeHeight,
        0.18,
        0.16,
        "rgba(244, 187, 220, 0.46)",
      );
      fillSoftSpot(
        context,
        safeWidth,
        safeHeight,
        0.86,
        0.82,
        "rgba(181, 218, 255, 0.38)",
      );
      break;
    case "sea-salt-blue":
      fillLinearGradient(context, safeWidth, safeHeight, "#f3fbff", "#c8e4ef");
      fillSoftSpot(
        context,
        safeWidth,
        safeHeight,
        0.8,
        0.15,
        "rgba(255, 255, 255, 0.55)",
      );
      break;
    case "warm-day":
      fillLinearGradient(context, safeWidth, safeHeight, "#fff9e9", "#f8d7c3");
      fillSoftSpot(
        context,
        safeWidth,
        safeHeight,
        0.18,
        0.18,
        "rgba(255, 255, 255, 0.62)",
      );
      break;
    case "graphite":
      fillLinearGradient(context, safeWidth, safeHeight, "#34383f", "#17191d");
      break;
    case "clean-white":
    default:
      context.fillStyle = "#f8fafc";
      context.fillRect(0, 0, safeWidth, safeHeight);
      break;
  }

  context.restore();
};
