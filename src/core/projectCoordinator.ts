import type { AnnotationStroke } from "../content/annotations";
import type { DocumentPresentationSettings } from "../shared/presentation";
import {
  CourseProjectSchemaError,
  createCourseProject,
  parseCourseProject,
  type CourseProject,
  type CourseSourceMetadata,
  type RecordingManifest,
  type RecordingStatus,
  type TeleprompterProjectState,
} from "./courseProject";
import type { OutputProfile } from "./outputProfile";
import {
  indexedDbProjectRepository,
  type ProjectRepository,
} from "./repositories";
import type {
  DocumentSession,
  ProjectSnapshot,
} from "./projectStore";

export const WHITEBOARD_SOURCE_ID = "source-whiteboard";

export type CourseProjectInitialization = {
  project: CourseProject | null;
  mode: "loaded" | "created-from-legacy" | "created-new" | "read-only";
  readOnly: boolean;
  message: string | null;
};

export type DocumentSourceState = {
  assetId: string;
  kind: "pdf" | "image" | "markdown" | "html";
  fileName: string;
  mimeType: string;
  pageCount: number;
  currentPageIndex: number;
  fitMode: "contain" | "cover";
  annotationsByPage: Record<string, AnnotationStroke[]>;
  presentation?: DocumentPresentationSettings;
};

export type RecordingManifestPatch = Partial<
  Pick<
    RecordingManifest,
    | "fileName"
    | "mimeType"
    | "status"
    | "storage"
    | "completedAt"
    | "durationMs"
    | "bytesWritten"
    | "errorMessage"
  >
>;

type CourseProjectCoordinatorOptions = {
  saveDelayMs?: number;
  now?: () => number;
  onError?: (error: Error) => void;
  repository?: ProjectRepository;
};

const clone = <T,>(value: T): T => {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
};

const createId = (prefix: string) => {
  const randomPart =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${randomPart}`;
};

const createWhiteboardSource = (
  now: number,
  snapshot?: ProjectSnapshot | null,
): CourseSourceMetadata => ({
  id: WHITEBOARD_SOURCE_ID,
  assetFormat: "excalidraw",
  surfaceMode: "live",
  renderEngine: "excalidraw",
  title: "Whiteboard",
  mimeType: "application/vnd.excalidraw+json",
  fileName: null,
  assetId: null,
  pageCount: 1,
  currentPageIndex: 0,
  fitMode: "contain",
  annotationsByPage: {},
  presentation: null,
  createdAt: snapshot?.savedAt ?? now,
  updatedAt: snapshot?.savedAt ?? now,
});

const sourceIdForAsset = (assetId: string) => `source-${assetId}`;

const documentRenderEngine = (kind: DocumentSourceState["kind"]) =>
  kind === "pdf"
    ? ("pdfjs" as const)
    : kind === "markdown"
      ? ("markdown" as const)
      : kind === "html"
        ? ("safe-html" as const)
        : ("image-bitmap" as const);

const documentFallbackTitle = (kind: DocumentSourceState["kind"]) =>
  kind === "pdf"
    ? "PDF"
    : kind === "markdown"
      ? "Markdown"
      : kind === "html"
        ? "Safe HTML"
        : "Image";

const documentFallbackMime = (kind: DocumentSourceState["kind"]) =>
  kind === "pdf"
    ? "application/pdf"
    : kind === "markdown"
      ? "text/markdown"
      : kind === "html"
        ? "text/html"
        : "image/*";

const createLegacyDocumentSource = (
  session: DocumentSession,
): CourseSourceMetadata => ({
  id: sourceIdForAsset(session.assetId),
  assetFormat: session.kind,
  surfaceMode: "paged",
  renderEngine: documentRenderEngine(session.kind),
  title: session.fileName || documentFallbackTitle(session.kind),
  mimeType: session.mimeType || documentFallbackMime(session.kind),
  fileName: session.fileName || null,
  assetId: session.assetId,
  // v2 did not store the PDF page count. The live adapter replaces this lower
  // bound with the authoritative value as soon as it opens the asset.
  pageCount: Math.max(1, session.currentPage + 1),
  currentPageIndex: Math.max(0, session.currentPage),
  fitMode: session.fitMode,
  annotationsByPage: clone(session.annotationsByPage),
  presentation: session.presentation ?? null,
  createdAt: session.savedAt,
  updatedAt: session.savedAt,
});

const createProjectFromLegacy = (
  snapshot: ProjectSnapshot | null,
  session: DocumentSession | null,
  now: number,
) => {
  const whiteboard = createWhiteboardSource(now, snapshot);
  const documentSource = session ? createLegacyDocumentSource(session) : null;
  const createdAt = Math.min(
    snapshot?.savedAt ?? now,
    session?.savedAt ?? now,
  );
  const project = createCourseProject({
    title: "Untitled course",
    now: createdAt,
    sources: documentSource ? [whiteboard, documentSource] : [whiteboard],
  });
  return parseCourseProject({
    ...project,
    updatedAt: Math.max(snapshot?.savedAt ?? createdAt, session?.savedAt ?? createdAt),
    activeSourceId: documentSource?.id ?? whiteboard.id,
  });
};

const ensureWhiteboardSource = (
  project: CourseProject,
  now: number,
): CourseProject => {
  if (project.sources.some((source) => source.id === WHITEBOARD_SOURCE_ID)) {
    return project;
  }
  return parseCourseProject({
    ...project,
    updatedAt: now,
    sources: [createWhiteboardSource(now), ...project.sources],
    activeSourceId: project.activeSourceId ?? WHITEBOARD_SOURCE_ID,
  });
};

const pendingRecordingFileName = (mimeType: string, startedAt: number) => {
  const extension = mimeType.includes("mp4") ? "mp4" : "webm";
  const timestamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
  return `excalidraw-recording-${timestamp}.${extension}`;
};

/**
 * Keeps the versioned JSON manifest synchronized with the existing v1/v2
 * stores. Binary Excalidraw files, imported documents and recordings remain in
 * their dedicated stores/downloads; this coordinator only writes references.
 */
export class CourseProjectCoordinator {
  private readonly saveDelayMs: number;
  private readonly now: () => number;
  private readonly onError?: (error: Error) => void;
  private readonly repository: ProjectRepository;
  private initialization: Promise<CourseProjectInitialization> | null = null;
  private project: CourseProject | null = null;
  private readOnly = false;
  private saveTimer: number | null = null;
  private pendingProject: CourseProject | null = null;
  private saveChain: Promise<void> = Promise.resolve();

  constructor(options: CourseProjectCoordinatorOptions = {}) {
    this.saveDelayMs = Math.max(0, options.saveDelayMs ?? 480);
    this.now = options.now ?? (() => Date.now());
    this.onError = options.onError;
    this.repository = options.repository ?? indexedDbProjectRepository;
  }

  initialize(): Promise<CourseProjectInitialization> {
    if (this.initialization) return this.initialization;
    this.initialization = this.initializeOnce();
    return this.initialization;
  }

  private async initializeOnce(): Promise<CourseProjectInitialization> {
    try {
      const current = await this.repository.loadCurrent();
      if (current) {
        const normalized = ensureWhiteboardSource(current, this.now());
        this.project = normalized;
        if (normalized !== current) await this.repository.saveCurrent(normalized);
        return {
          project: clone(normalized),
          mode: "loaded",
          readOnly: false,
          message: null,
        };
      }

      const [snapshot, session] = await Promise.all([
        this.repository.loadLegacySnapshot(),
        this.repository.loadLegacyDocumentSession(),
      ]);
      const created = createProjectFromLegacy(snapshot, session, this.now());
      this.project = await this.repository.saveCurrent(created);
      return {
        project: clone(this.project),
        mode: snapshot || session ? "created-from-legacy" : "created-new",
        readOnly: false,
        message: null,
      };
    } catch (error) {
      const normalizedError =
        error instanceof Error ? error : new Error("Could not open the course project.");
      // A future schema must never be replaced by an older application. We use
      // the same conservative behavior for malformed manifests: the legacy UI
      // can still open, but this coordinator will not write the v3 ledger.
      this.readOnly = true;
      this.project = null;
      const futureSchema =
        error instanceof CourseProjectSchemaError &&
        error.code === "UNSUPPORTED_NEWER_VERSION";
      return {
        project: null,
        mode: "read-only",
        readOnly: true,
        message: futureSchema
          ? "当前课程项目由更新版本创建，已进入只读兼容模式；本版本不会覆盖其清单。"
          : `课程项目清单无法安全读取，已停止写入以保护原数据：${normalizedError.message}`,
      };
    }
  }

  getProject(): CourseProject | null {
    return this.project ? clone(this.project) : null;
  }

  isReadOnly() {
    return this.readOnly;
  }

  setOutputProfile(outputProfile: OutputProfile) {
    this.mutate((project) => ({
      ...project,
      outputProfile: clone(outputProfile),
    }));
  }

  setTeleprompter(teleprompter: TeleprompterProjectState) {
    this.mutate((project) => ({
      ...project,
      teleprompter: clone(teleprompter),
    }));
  }

  setWhiteboardActive(options?: { removeDocumentAssetId?: string | null }) {
    this.mutate((project) => {
      const now = this.now();
      const sources = project.sources.some(
        (source) => source.id === WHITEBOARD_SOURCE_ID,
      )
        ? project.sources.map((source) =>
            source.id === WHITEBOARD_SOURCE_ID
              ? { ...source, updatedAt: now }
              : source,
          )
        : [createWhiteboardSource(now), ...project.sources];
      const retiredAssetId = options?.removeDocumentAssetId?.trim();
      return {
        ...project,
        sources: retiredAssetId
          ? sources.filter((source) => source.assetId !== retiredAssetId)
          : sources,
        activeSourceId: WHITEBOARD_SOURCE_ID,
      };
    });
  }

  touchWhiteboard() {
    this.mutate((project) => ({
      ...project,
      sources: project.sources.map((source) =>
        source.id === WHITEBOARD_SOURCE_ID
          ? { ...source, updatedAt: this.now() }
          : source,
      ),
    }));
  }

  setDocumentSource(state: DocumentSourceState) {
    const sourceId = sourceIdForAsset(state.assetId);
    this.mutate((project) => {
      const now = this.now();
      const existing = project.sources.find((source) => source.id === sourceId);
      const source: CourseSourceMetadata = {
        id: sourceId,
        assetFormat: state.kind,
        surfaceMode: "paged",
        renderEngine: documentRenderEngine(state.kind),
        title: state.fileName || documentFallbackTitle(state.kind),
        mimeType: state.mimeType || documentFallbackMime(state.kind),
        fileName: state.fileName || null,
        assetId: state.assetId,
        pageCount: Math.max(1, Math.floor(state.pageCount)),
        currentPageIndex: Math.min(
          Math.max(0, Math.floor(state.currentPageIndex)),
          Math.max(0, Math.floor(state.pageCount) - 1),
        ),
        fitMode: state.fitMode,
        annotationsByPage: clone(state.annotationsByPage),
        presentation: state.presentation ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      // The current web UI owns one imported document at a time. Retiring the
      // previous imported reference mirrors its atomic v2 asset replacement.
      const retained = project.sources.filter(
        (candidate) =>
          candidate.id === WHITEBOARD_SOURCE_ID ||
          (candidate.assetFormat !== "pdf" &&
            candidate.assetFormat !== "image" &&
            candidate.assetFormat !== "markdown" &&
            candidate.assetFormat !== "html") ||
          candidate.id === sourceId,
      );
      const existingIndex = retained.findIndex(
        (candidate) => candidate.id === sourceId,
      );
      if (existingIndex >= 0) retained[existingIndex] = source;
      else retained.push(source);
      return { ...project, sources: retained, activeSourceId: sourceId };
    });
  }

  beginRecording(options: {
    mimeType: string;
    outputProfile: OutputProfile;
    startedAt?: number;
  }) {
    const id = createId("recording");
    const startedAt = options.startedAt ?? this.now();
    this.mutate((project) => ({
      ...project,
      recordings: [
        ...project.recordings,
        {
          id,
          fileName: pendingRecordingFileName(options.mimeType, startedAt),
          mimeType: options.mimeType || "video/webm",
          status: "recording",
          storage: { kind: "download", reference: null },
          outputProfile: clone(options.outputProfile),
          startedAt,
          updatedAt: startedAt,
          completedAt: null,
          durationMs: 0,
          bytesWritten: 0,
          errorMessage: null,
        },
      ],
    }));
    return id;
  }

  updateRecording(
    id: string,
    patch: RecordingManifestPatch & { status?: RecordingStatus },
  ) {
    this.mutate((project) => ({
      ...project,
      recordings: project.recordings.map((recording) =>
        recording.id === id
          ? { ...recording, ...clone(patch), updatedAt: this.now() }
          : recording,
      ),
    }));
  }

  async flush(): Promise<void> {
    await this.initialize();
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const pending = this.pendingProject;
    this.pendingProject = null;
    if (!pending || this.readOnly) return this.saveChain;

    const operation = this.saveChain
      .catch(() => undefined)
      .then(async () => {
        const saved = await this.repository.saveCurrent(pending);
        // Do not replace a newer in-memory mutation with an older save result.
        if (!this.pendingProject && this.project?.updatedAt === pending.updatedAt) {
          this.project = saved;
        }
      });
    // Keep the sequencing chain fulfilled, while handling this attempt
    // separately so a failed snapshot remains pending for the next flush.
    this.saveChain = operation.catch(() => undefined);
    try {
      await operation;
    } catch (error) {
      if (!this.pendingProject && this.project?.updatedAt === pending.updatedAt) {
        this.pendingProject = pending;
      }
      const normalized =
        error instanceof Error ? error : new Error("Could not save the course project.");
      this.onError?.(normalized);
    }
  }

  private mutate(mutator: (project: CourseProject) => CourseProject) {
    if (this.readOnly) return;
    if (!this.project) {
      void this.initialize().then(() => {
        if (this.project && !this.readOnly) this.applyMutation(mutator);
      });
      return;
    }
    this.applyMutation(mutator);
  }

  private applyMutation(mutator: (project: CourseProject) => CourseProject) {
    if (!this.project || this.readOnly) return;
    const next = parseCourseProject({
      ...mutator(clone(this.project)),
      updatedAt: this.now(),
    });
    this.project = next;
    this.pendingProject = next;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, this.saveDelayMs);
  }
}
