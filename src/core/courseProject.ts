import type { AnnotationStroke, NormalizedPoint } from "../content/annotations";
import {
  parseDocumentPresentationSettings,
  type DocumentPresentationSettings,
} from "../shared/presentation";
import {
  CANVAS_STYLES,
  OUTPUT_RESOLUTIONS,
  createCustomAspect,
  createOutputProfile,
  type AspectChoice,
  type AspectPresetId,
  type CanvasStyle,
  type OutputProfile,
  type OutputResolution,
} from "./outputProfile";

export const COURSE_PROJECT_SCHEMA_VERSION = 1 as const;

/** Raw format, presentation behavior and renderer are deliberately orthogonal. */
export type CourseAssetFormat =
  | "excalidraw"
  | "image"
  | "pdf"
  | "markdown"
  | "html"
  | "ppt"
  | "pptx";
export type CourseSurfaceMode = "paged" | "scroll" | "live";
export type CourseRenderEngine =
  | "excalidraw"
  | "image-bitmap"
  | "pdfjs"
  | "markdown"
  | "safe-html"
  | "webview2"
  | "converted-pdf";

export type CourseSourceMetadata = {
  id: string;
  assetFormat: CourseAssetFormat;
  surfaceMode: CourseSurfaceMode;
  renderEngine: CourseRenderEngine;
  title: string;
  mimeType: string;
  fileName: string | null;
  /** Blob/object identifier. Excalidraw sources can be fully embedded and use null. */
  assetId: string | null;
  pageCount: number;
  currentPageIndex: number;
  fitMode: "contain" | "cover";
  annotationsByPage: Record<string, AnnotationStroke[]>;
  /** Controlled Markdown/HTML layout. Null for other source formats. */
  presentation: DocumentPresentationSettings | null;
  createdAt: number;
  updatedAt: number;
};

export type RecordingStatus =
  | "recording"
  | "finalizing"
  | "complete"
  | "interrupted"
  | "failed";

export type RecordingStorage = {
  kind: "download" | "opfs" | "desktop-file";
  /** An opaque host reference. It must not be interpreted as a trusted path. */
  reference: string | null;
};

export type RecordingManifest = {
  id: string;
  fileName: string;
  mimeType: string;
  status: RecordingStatus;
  storage: RecordingStorage;
  outputProfile: OutputProfile;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
  durationMs: number;
  bytesWritten: number;
  errorMessage: string | null;
};

export type TeleprompterProjectState = {
  text: string;
  scrollSpeed: number;
  opacity: number;
  position: { x: number; y: number };
  size: { width: number; height: number };
};

/**
 * The JSON-compatible project manifest. Binary source files and recordings are
 * intentionally referenced rather than embedded so the manifest remains fast
 * to migrate, list and save atomically.
 */
export type CourseProject = {
  schemaVersion: typeof COURSE_PROJECT_SCHEMA_VERSION;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  sources: CourseSourceMetadata[];
  activeSourceId: string | null;
  teleprompter: TeleprompterProjectState;
  outputProfile: OutputProfile;
  recordings: RecordingManifest[];
};

export type CourseProjectSummary = Pick<
  CourseProject,
  "id" | "title" | "createdAt" | "updatedAt" | "activeSourceId"
> & {
  sourceCount: number;
  recordingCount: number;
};

export type CourseProjectSchemaErrorCode =
  | "INVALID_PROJECT"
  | "UNSUPPORTED_OLDER_VERSION"
  | "UNSUPPORTED_NEWER_VERSION";

export class CourseProjectSchemaError extends Error {
  readonly code: CourseProjectSchemaErrorCode;
  readonly readOnly: boolean;
  readonly foundVersion: number | null;

  constructor(
    code: CourseProjectSchemaErrorCode,
    message: string,
    options?: { foundVersion?: number | null; readOnly?: boolean },
  ) {
    super(message);
    this.name = "CourseProjectSchemaError";
    this.code = code;
    this.foundVersion = options?.foundVersion ?? null;
    this.readOnly = options?.readOnly ?? false;
  }
}

export type CourseProjectReadResult = {
  project: CourseProject;
  /** null means that the input was already a valid current manifest. */
  migratedFromVersion: 0 | null;
};

export type CourseProjectTryReadResult =
  | ({ ok: true } & CourseProjectReadResult)
  | { ok: false; error: CourseProjectSchemaError; readOnly: boolean };

const ASSET_FORMATS = new Set<CourseAssetFormat>([
  "excalidraw",
  "image",
  "pdf",
  "html",
  "markdown",
  "ppt",
  "pptx",
]);
const SURFACE_MODES = new Set<CourseSurfaceMode>(["paged", "scroll", "live"]);
const RENDER_ENGINES = new Set<CourseRenderEngine>([
  "excalidraw",
  "image-bitmap",
  "pdfjs",
  "markdown",
  "safe-html",
  "webview2",
  "converted-pdf",
]);
const RECORDING_STATUSES = new Set<RecordingStatus>([
  "recording",
  "finalizing",
  "complete",
  "interrupted",
  "failed",
]);
const STORAGE_KINDS = new Set<RecordingStorage["kind"]>([
  "download",
  "opfs",
  "desktop-file",
]);
const ASPECT_PRESETS = new Set<AspectPresetId>([
  "16:9",
  "4:3",
  "3:4",
  "9:16",
  "1:1",
]);
const RESOLUTIONS = new Set<OutputResolution>(
  OUTPUT_RESOLUTIONS.map((entry) => entry.id),
);
const STYLES = new Set<CanvasStyle>(CANVAS_STYLES.map((entry) => entry.id));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function fail(path: string, message: string): never {
  throw new CourseProjectSchemaError(
    "INVALID_PROJECT",
    `Invalid course project at ${path}: ${message}`,
  );
}

const requiredRecord = (
  value: unknown,
  path: string,
): Record<string, unknown> => {
  if (!isRecord(value)) fail(path, "expected an object");
  return value;
};

const requiredString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    fail(path, "expected a non-empty string");
  }
  return value.trim();
};

const nullableString = (value: unknown, path: string): string | null => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") fail(path, "expected a string or null");
  return value;
};

const finiteNumber = (
  value: unknown,
  path: string,
  minimum = 0,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    fail(path, `expected a finite number greater than or equal to ${minimum}`);
  }
  return value;
};

const finiteInteger = (
  value: unknown,
  path: string,
  minimum = 0,
): number =>
  Math.floor(finiteNumber(value, path, minimum));

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

const createId = (prefix: string) => {
  const randomPart =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${randomPart}`;
};

const defaultTeleprompterState = (): TeleprompterProjectState => ({
  text: "",
  scrollSpeed: 34,
  opacity: 0.9,
  position: { x: 24, y: 96 },
  size: { width: 420, height: 520 },
});

const parseAspect = (value: unknown, path: string): AspectChoice => {
  if (typeof value === "string" && ASPECT_PRESETS.has(value as AspectPresetId)) {
    return value as AspectPresetId;
  }
  const record = requiredRecord(value, path);
  if (record.id !== "custom") fail(`${path}.id`, 'expected "custom"');
  return createCustomAspect(
    finiteNumber(record.width, `${path}.width`, 1),
    finiteNumber(record.height, `${path}.height`, 1),
  );
};

const parseOutputProfile = (
  value: unknown,
  path: string,
  legacy = false,
): OutputProfile => {
  if ((value === undefined || value === null) && legacy) {
    return createOutputProfile();
  }
  const record = requiredRecord(value, path);
  const aspect = parseAspect(record.aspect, `${path}.aspect`);
  if (
    typeof record.resolution !== "string" ||
    !RESOLUTIONS.has(record.resolution as OutputResolution)
  ) {
    fail(`${path}.resolution`, "expected a supported output resolution");
  }
  if (
    typeof record.style !== "string" ||
    !STYLES.has(record.style as CanvasStyle)
  ) {
    fail(`${path}.style`, "expected a supported canvas style");
  }
  const captureRegion = requiredRecord(
    record.captureRegion,
    `${path}.captureRegion`,
  );
  return createOutputProfile({
    aspect,
    resolution: record.resolution as OutputResolution,
    style: record.style as CanvasStyle,
    captureRegion: {
      x: finiteNumber(captureRegion.x, `${path}.captureRegion.x`),
      y: finiteNumber(captureRegion.y, `${path}.captureRegion.y`),
      width: finiteNumber(captureRegion.width, `${path}.captureRegion.width`),
      height: finiteNumber(captureRegion.height, `${path}.captureRegion.height`),
    },
  });
};

const parsePoint = (value: unknown, path: string): NormalizedPoint => {
  const record = requiredRecord(value, path);
  return {
    x: clamp(finiteNumber(record.x, `${path}.x`), 0, 1),
    y: clamp(finiteNumber(record.y, `${path}.y`), 0, 1),
    pressure: clamp(finiteNumber(record.pressure, `${path}.pressure`), 0, 1),
    at: finiteNumber(record.at, `${path}.at`),
  };
};

const parseStroke = (value: unknown, path: string): AnnotationStroke => {
  const record = requiredRecord(value, path);
  if (
    record.tool !== "laser" &&
    record.tool !== "pen" &&
    record.tool !== "highlighter"
  ) {
    fail(`${path}.tool`, "expected laser, pen or highlighter");
  }
  if (!Array.isArray(record.points)) fail(`${path}.points`, "expected an array");
  const coordinateSpace =
    record.coordinateSpace === undefined
      ? "stage-v1"
      : record.coordinateSpace;
  if (coordinateSpace !== "stage-v1" && coordinateSpace !== "page-v1") {
    fail(
      `${path}.coordinateSpace`,
      "expected stage-v1, page-v1 or an omitted legacy value",
    );
  }
  return {
    id: requiredString(record.id, `${path}.id`),
    pageIndex: finiteInteger(record.pageIndex, `${path}.pageIndex`),
    tool: record.tool,
    color: requiredString(record.color, `${path}.color`),
    width: finiteNumber(record.width, `${path}.width`),
    opacity: clamp(finiteNumber(record.opacity, `${path}.opacity`), 0, 1),
    coordinateSpace,
    points: record.points.map((point, index) =>
      parsePoint(point, `${path}.points[${index}]`),
    ),
    createdAt: finiteNumber(record.createdAt, `${path}.createdAt`),
  };
};

const parseAnnotations = (
  value: unknown,
  path: string,
): Record<string, AnnotationStroke[]> => {
  if (value === undefined || value === null) return {};
  const record = requiredRecord(value, path);
  const result: Record<string, AnnotationStroke[]> = {};
  for (const [page, strokes] of Object.entries(record)) {
    if (!/^\d+$/.test(page)) fail(`${path}.${page}`, "expected a page index key");
    if (!Array.isArray(strokes)) fail(`${path}.${page}`, "expected an array");
    result[page] = strokes.map((stroke, index) =>
      parseStroke(stroke, `${path}.${page}[${index}]`),
    );
  }
  return result;
};

const mapLegacySourceKind = (
  value: unknown,
  path: string,
): Pick<
  CourseSourceMetadata,
  "assetFormat" | "surfaceMode" | "renderEngine"
> => {
  switch (value) {
    case "excalidraw":
      return {
        assetFormat: "excalidraw",
        surfaceMode: "live",
        renderEngine: "excalidraw",
      };
    case "image":
      return {
        assetFormat: "image",
        surfaceMode: "paged",
        renderEngine: "image-bitmap",
      };
    case "pdf":
      return {
        assetFormat: "pdf",
        surfaceMode: "paged",
        renderEngine: "pdfjs",
      };
    case "markdown":
      return {
        assetFormat: "markdown",
        surfaceMode: "paged",
        renderEngine: "markdown",
      };
    case "html":
    case "html-capture":
      return {
        assetFormat: "html",
        surfaceMode: "live",
        renderEngine: "webview2",
      };
    case "ppt":
    case "pptx":
      return {
        assetFormat: value,
        surfaceMode: "paged",
        renderEngine: "converted-pdf",
      };
    default:
      return fail(path, "expected a recognized legacy source kind");
  }
};

const parseSource = (
  value: unknown,
  path: string,
  options?: { legacy?: boolean; now?: number },
): CourseSourceMetadata => {
  const record = requiredRecord(value, path);
  const legacy = options?.legacy ?? false;
  const sourceAxes = legacy
    ? mapLegacySourceKind(record.kind, `${path}.kind`)
    : {
        assetFormat:
          typeof record.assetFormat === "string" &&
          ASSET_FORMATS.has(record.assetFormat as CourseAssetFormat)
            ? (record.assetFormat as CourseAssetFormat)
            : fail(`${path}.assetFormat`, "expected a supported asset format"),
        surfaceMode:
          typeof record.surfaceMode === "string" &&
          SURFACE_MODES.has(record.surfaceMode as CourseSurfaceMode)
            ? (record.surfaceMode as CourseSurfaceMode)
            : fail(`${path}.surfaceMode`, "expected paged, scroll or live"),
        renderEngine:
          typeof record.renderEngine === "string" &&
          RENDER_ENGINES.has(record.renderEngine as CourseRenderEngine)
            ? (record.renderEngine as CourseRenderEngine)
            : fail(`${path}.renderEngine`, "expected a supported render engine"),
      };
  const pageCount =
    record.pageCount === undefined && legacy
      ? 1
      : finiteInteger(record.pageCount, `${path}.pageCount`, 1);
  const rawPage = legacy ? (record.currentPageIndex ?? record.currentPage ?? 0) : record.currentPageIndex;
  const currentPageIndex = Math.min(
    pageCount - 1,
    finiteInteger(rawPage, `${path}.currentPageIndex`),
  );
  const now = options?.now ?? Date.now();
  const createdAt =
    record.createdAt === undefined && legacy
      ? now
      : finiteNumber(record.createdAt, `${path}.createdAt`);
  const updatedAt =
    record.updatedAt === undefined && legacy
      ? finiteNumber(record.savedAt ?? createdAt, `${path}.updatedAt`)
      : finiteNumber(record.updatedAt, `${path}.updatedAt`);
  const assetId = nullableString(record.assetId, `${path}.assetId`);
  const fallbackId = assetId ? `source-${assetId}` : createId("source");
  const fileName = nullableString(record.fileName, `${path}.fileName`);
  return {
    id:
      record.id === undefined && legacy
        ? fallbackId
        : requiredString(record.id, `${path}.id`),
    ...sourceAxes,
    title:
      record.title === undefined && legacy
        ? fileName ??
          (sourceAxes.assetFormat === "excalidraw"
            ? "Whiteboard"
            : "Imported source")
        : requiredString(record.title, `${path}.title`),
    mimeType:
      record.mimeType === undefined && legacy
        ? sourceAxes.assetFormat === "pdf"
          ? "application/pdf"
          : sourceAxes.assetFormat === "image"
            ? "image/*"
            : "application/octet-stream"
        : requiredString(record.mimeType, `${path}.mimeType`),
    fileName,
    assetId,
    pageCount,
    currentPageIndex,
    fitMode:
      record.fitMode === "cover" || record.fitMode === "contain"
        ? record.fitMode
        : legacy
          ? "contain"
          : fail(`${path}.fitMode`, "expected contain or cover"),
    annotationsByPage: parseAnnotations(
      record.annotationsByPage,
      `${path}.annotationsByPage`,
    ),
    presentation:
      record.presentation === undefined || record.presentation === null
        ? null
        : parseDocumentPresentationSettings(record.presentation) ??
          fail(
            `${path}.presentation`,
            "expected a supported presentation layout",
          ),
    createdAt,
    updatedAt,
  };
};

const parseRecording = (
  value: unknown,
  path: string,
  legacy = false,
): RecordingManifest => {
  const record = requiredRecord(value, path);
  if (
    typeof record.status !== "string" ||
    !RECORDING_STATUSES.has(record.status as RecordingStatus)
  ) {
    fail(`${path}.status`, "expected a supported recording status");
  }
  const storage =
    record.storage === undefined && legacy
      ? { kind: "download" as const, reference: null }
      : requiredRecord(record.storage, `${path}.storage`);
  if (
    typeof storage.kind !== "string" ||
    !STORAGE_KINDS.has(storage.kind as RecordingStorage["kind"])
  ) {
    fail(`${path}.storage.kind`, "expected a supported recording storage kind");
  }
  const startedAt = finiteNumber(record.startedAt, `${path}.startedAt`);
  const updatedAt =
    record.updatedAt === undefined && legacy
      ? startedAt
      : finiteNumber(record.updatedAt, `${path}.updatedAt`);
  return {
    id: requiredString(record.id, `${path}.id`),
    fileName: requiredString(record.fileName, `${path}.fileName`),
    mimeType: requiredString(record.mimeType, `${path}.mimeType`),
    status: record.status as RecordingStatus,
    storage: {
      kind: storage.kind as RecordingStorage["kind"],
      reference: nullableString(storage.reference, `${path}.storage.reference`),
    },
    outputProfile: parseOutputProfile(
      record.outputProfile,
      `${path}.outputProfile`,
      legacy,
    ),
    startedAt,
    updatedAt,
    completedAt:
      record.completedAt === null || record.completedAt === undefined
        ? null
        : finiteNumber(record.completedAt, `${path}.completedAt`),
    durationMs: finiteNumber(record.durationMs ?? 0, `${path}.durationMs`),
    bytesWritten: finiteNumber(record.bytesWritten ?? 0, `${path}.bytesWritten`),
    errorMessage: nullableString(record.errorMessage, `${path}.errorMessage`),
  };
};

const parseTeleprompter = (
  value: unknown,
  path: string,
  legacyText?: unknown,
): TeleprompterProjectState => {
  const defaults = defaultTeleprompterState();
  if (value === undefined || value === null) {
    if (legacyText !== undefined && typeof legacyText !== "string") {
      fail("$.teleprompterText", "expected a string");
    }
    return { ...defaults, text: typeof legacyText === "string" ? legacyText : "" };
  }
  const record = requiredRecord(value, path);
  const position = record.position === undefined ? defaults.position : requiredRecord(record.position, `${path}.position`);
  const size = record.size === undefined ? defaults.size : requiredRecord(record.size, `${path}.size`);
  return {
    text: typeof record.text === "string" ? record.text : "",
    scrollSpeed:
      record.scrollSpeed === undefined
        ? defaults.scrollSpeed
        : clamp(
            finiteNumber(record.scrollSpeed, `${path}.scrollSpeed`),
            8,
            100,
          ),
    opacity:
      record.opacity === undefined
        ? defaults.opacity
        : clamp(finiteNumber(record.opacity, `${path}.opacity`), 0.1, 1),
    position: {
      x: finiteNumber(position.x, `${path}.position.x`),
      y: finiteNumber(position.y, `${path}.position.y`),
    },
    size: {
      width: finiteNumber(size.width, `${path}.size.width`, 160),
      height: finiteNumber(size.height, `${path}.size.height`, 120),
    },
  };
};

const ensureUniqueIds = (values: readonly { id: string }[], path: string) => {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) fail(path, `duplicate id "${value.id}"`);
    ids.add(value.id);
  }
};

const parseCurrentProject = (record: Record<string, unknown>): CourseProject => {
  if (!Array.isArray(record.sources)) fail("$.sources", "expected an array");
  if (!Array.isArray(record.recordings)) fail("$.recordings", "expected an array");
  const sources = record.sources.map((source, index) =>
    parseSource(source, `$.sources[${index}]`),
  );
  const recordings = record.recordings.map((recording, index) =>
    parseRecording(recording, `$.recordings[${index}]`),
  );
  ensureUniqueIds(sources, "$.sources");
  ensureUniqueIds(recordings, "$.recordings");
  const activeSourceId = nullableString(record.activeSourceId, "$.activeSourceId");
  if (activeSourceId !== null && !sources.some((source) => source.id === activeSourceId)) {
    fail("$.activeSourceId", "does not reference a source in this project");
  }
  return {
    schemaVersion: COURSE_PROJECT_SCHEMA_VERSION,
    id: requiredString(record.id, "$.id"),
    title: requiredString(record.title, "$.title"),
    createdAt: finiteNumber(record.createdAt, "$.createdAt"),
    updatedAt: finiteNumber(record.updatedAt, "$.updatedAt"),
    sources,
    activeSourceId,
    teleprompter: parseTeleprompter(record.teleprompter, "$.teleprompter"),
    outputProfile: parseOutputProfile(record.outputProfile, "$.outputProfile"),
    recordings,
  };
};

const LEGACY_KEYS = new Set([
  "id",
  "title",
  "createdAt",
  "updatedAt",
  "savedAt",
  "source",
  "sources",
  "assetId",
  "kind",
  "outputProfile",
  "teleprompter",
  "teleprompterText",
  "recordings",
  "elements",
]);

const migrateLegacyProject = (record: Record<string, unknown>): CourseProject => {
  if (!Object.keys(record).some((key) => LEGACY_KEYS.has(key))) {
    fail("$", "the unversioned object is not a recognized legacy project");
  }
  const now = Date.now();
  let rawSources: unknown[] = [];
  if (Array.isArray(record.sources)) rawSources = record.sources;
  else if (record.source !== undefined) rawSources = [record.source];
  else if (typeof record.kind === "string") rawSources = [record];
  else if (Array.isArray(record.elements)) {
    rawSources = [
      {
        kind: "excalidraw",
        title: "Whiteboard",
        mimeType: "application/vnd.excalidraw+json",
        pageCount: 1,
        currentPageIndex: 0,
      },
    ];
  }
  const sources = rawSources.map((source, index) =>
    parseSource(source, `$.sources[${index}]`, { legacy: true, now }),
  );
  ensureUniqueIds(sources, "$.sources");
  const rawRecordings = Array.isArray(record.recordings) ? record.recordings : [];
  const recordings = rawRecordings.map((recording, index) =>
    parseRecording(recording, `$.recordings[${index}]`, true),
  );
  ensureUniqueIds(recordings, "$.recordings");
  const createdAt =
    record.createdAt === undefined
      ? finiteNumber(record.savedAt ?? now, "$.createdAt")
      : finiteNumber(record.createdAt, "$.createdAt");
  const updatedAt =
    record.updatedAt === undefined
      ? finiteNumber(record.savedAt ?? createdAt, "$.updatedAt")
      : finiteNumber(record.updatedAt, "$.updatedAt");
  const requestedActiveId = nullableString(record.activeSourceId, "$.activeSourceId");
  const activeSourceId =
    requestedActiveId && sources.some((source) => source.id === requestedActiveId)
      ? requestedActiveId
      : sources[0]?.id ?? null;
  return {
    schemaVersion: COURSE_PROJECT_SCHEMA_VERSION,
    id:
      record.id === undefined
        ? createId("project")
        : requiredString(record.id, "$.id"),
    title:
      typeof record.title === "string" && record.title.trim()
        ? record.title.trim()
        : "Untitled course",
    createdAt,
    updatedAt,
    sources,
    activeSourceId,
    teleprompter: parseTeleprompter(
      record.teleprompter,
      "$.teleprompter",
      record.teleprompterText,
    ),
    outputProfile: parseOutputProfile(
      record.outputProfile,
      "$.outputProfile",
      true,
    ),
    recordings,
  };
};

/** Validates a manifest and migrates recognized unversioned/version-0 data. */
export const readCourseProject = (input: unknown): CourseProjectReadResult => {
  const record = requiredRecord(input, "$");
  const rawVersion = record.schemaVersion;
  if (rawVersion === undefined || rawVersion === 0) {
    return { project: migrateLegacyProject(record), migratedFromVersion: 0 };
  }
  if (typeof rawVersion !== "number" || !Number.isInteger(rawVersion)) {
    fail("$.schemaVersion", "expected an integer schema version");
  }
  if (rawVersion > COURSE_PROJECT_SCHEMA_VERSION) {
    throw new CourseProjectSchemaError(
      "UNSUPPORTED_NEWER_VERSION",
      `Course project schema version ${rawVersion} is newer than this app supports (${COURSE_PROJECT_SCHEMA_VERSION}). Open it read-only and update the app before saving it.`,
      { foundVersion: rawVersion, readOnly: true },
    );
  }
  if (rawVersion < COURSE_PROJECT_SCHEMA_VERSION) {
    throw new CourseProjectSchemaError(
      "UNSUPPORTED_OLDER_VERSION",
      `Course project schema version ${rawVersion} has no registered migration.`,
      { foundVersion: rawVersion },
    );
  }
  return { project: parseCurrentProject(record), migratedFromVersion: null };
};

export const parseCourseProject = (input: unknown): CourseProject =>
  readCourseProject(input).project;

export const tryReadCourseProject = (
  input: unknown,
): CourseProjectTryReadResult => {
  try {
    return { ok: true, ...readCourseProject(input) };
  } catch (error) {
    const schemaError =
      error instanceof CourseProjectSchemaError
        ? error
        : new CourseProjectSchemaError(
            "INVALID_PROJECT",
            error instanceof Error ? error.message : "Invalid course project.",
          );
    return { ok: false, error: schemaError, readOnly: schemaError.readOnly };
  }
};

export const createCourseProject = (options?: {
  id?: string;
  title?: string;
  now?: number;
  outputProfile?: OutputProfile;
  sources?: CourseSourceMetadata[];
}): CourseProject => {
  const now = options?.now ?? Date.now();
  const sources = options?.sources ?? [];
  const draft: CourseProject = {
    schemaVersion: COURSE_PROJECT_SCHEMA_VERSION,
    id: options?.id ?? createId("project"),
    title: options?.title?.trim() || "Untitled course",
    createdAt: now,
    updatedAt: now,
    sources,
    activeSourceId: sources[0]?.id ?? null,
    teleprompter: defaultTeleprompterState(),
    outputProfile: options?.outputProfile ?? createOutputProfile(),
    recordings: [],
  };
  // The factory and imported manifests share the same invariants and cloning.
  return parseCurrentProject(draft as unknown as Record<string, unknown>);
};

export const summarizeCourseProject = (
  project: CourseProject,
): CourseProjectSummary => ({
  id: project.id,
  title: project.title,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
  activeSourceId: project.activeSourceId,
  sourceCount: project.sources.length,
  recordingCount: project.recordings.length,
});
