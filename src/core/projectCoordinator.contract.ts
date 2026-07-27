import {
  CourseProjectSchemaError,
  parseCourseProject,
  summarizeCourseProject,
  type CourseProject,
} from "./courseProject";
import {
  CourseProjectCoordinator,
  WHITEBOARD_SOURCE_ID,
} from "./projectCoordinator";
import type { ProjectRepository } from "./repositories";
import type { DocumentSession, ProjectSnapshot } from "./projectStore";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Project coordinator contract failed: ${message}`);
}

type MemoryRepositoryOptions = {
  current?: CourseProject | null;
  legacySnapshot?: ProjectSnapshot | null;
  legacyDocument?: DocumentSession | null;
  loadError?: Error | null;
  failNextSaves?: number;
};

const createMemoryRepository = (options: MemoryRepositoryOptions = {}) => {
  const projects = new Map<string, CourseProject>();
  if (options.current) projects.set(options.current.id, options.current);
  let currentId = options.current?.id ?? null;
  let legacySnapshot = options.legacySnapshot ?? null;
  let legacyDocument = options.legacyDocument ?? null;
  let saveCount = 0;
  let remainingSaveFailures = options.failNextSaves ?? 0;

  const repository: ProjectRepository = {
    async loadLegacySnapshot() {
      return legacySnapshot;
    },
    async saveLegacySnapshot(snapshot) {
      legacySnapshot = snapshot;
    },
    async loadLegacyDocumentSession() {
      return legacyDocument;
    },
    async saveLegacyDocumentSession(session) {
      legacyDocument = session;
    },
    async clearLegacyDocumentSession() {
      legacyDocument = null;
    },
    async list() {
      return [...projects.values()].map(summarizeCourseProject);
    },
    async listManifests() {
      return [...projects.values()].map((project) => parseCourseProject(project));
    },
    async load(projectId) {
      const project = projects.get(projectId);
      return project ? parseCourseProject(project) : null;
    },
    async loadCurrent() {
      if (options.loadError) throw options.loadError;
      if (!currentId) return null;
      const project = projects.get(currentId);
      return project ? parseCourseProject(project) : null;
    },
    async getCurrentId() {
      return currentId;
    },
    async save(project) {
      const parsed = parseCourseProject(project);
      projects.set(parsed.id, parsed);
      saveCount += 1;
      return parsed;
    },
    async saveCurrent(project) {
      if (remainingSaveFailures > 0) {
        remainingSaveFailures -= 1;
        throw new Error("simulated project save failure");
      }
      const parsed = parseCourseProject(project);
      projects.set(parsed.id, parsed);
      currentId = parsed.id;
      saveCount += 1;
      return parsed;
    },
    async selectCurrent(projectId) {
      if (projectId !== null && !projects.has(projectId)) {
        throw new DOMException("Project not found.", "NotFoundError");
      }
      currentId = projectId;
    },
  };

  return {
    repository,
    getSaveCount: () => saveCount,
    getCurrent: () =>
      currentId ? parseCourseProject(projects.get(currentId)) : null,
  };
};

/** Browser-callable persistence/migration/recording-ledger contract. */
export const runProjectCoordinatorContract = async () => {
  let now = 1_784_097_600_000;
  const legacySnapshot: ProjectSnapshot = {
    elements: [],
    files: {},
    appState: {},
    savedAt: now - 2_000,
  };
  const legacyDocument: DocumentSession = {
    assetId: "legacy-pdf-asset",
    kind: "pdf",
    fileName: "legacy-slides.pdf",
    mimeType: "application/pdf",
    currentPage: 2,
    fitMode: "contain",
    annotationsByPage: {},
    savedAt: now - 1_000,
  };
  const memory = createMemoryRepository({ legacySnapshot, legacyDocument });
  const coordinator = new CourseProjectCoordinator({
    repository: memory.repository,
    saveDelayMs: 0,
    now: () => ++now,
  });

  const initialized = await coordinator.initialize();
  assert(initialized.mode === "created-from-legacy", "legacy mode");
  assert(initialized.project?.sources.length === 2, "legacy sources");
  assert(
    initialized.project?.activeSourceId === "source-legacy-pdf-asset",
    "legacy active document",
  );

  const recordingId = coordinator.beginRecording({
    mimeType: "video/mp4",
    outputProfile: initialized.project!.outputProfile,
    startedAt: now,
  });
  coordinator.updateRecording(recordingId, {
    status: "complete",
    storage: { kind: "opfs", reference: "session-contract" },
    completedAt: ++now,
    durationMs: 12_000,
    bytesWritten: 42_000,
  });
  coordinator.setDocumentSource({
    assetId: "new-image-asset",
    kind: "image",
    fileName: "lesson.png",
    mimeType: "image/png",
    pageCount: 1,
    currentPageIndex: 0,
    fitMode: "cover",
    annotationsByPage: {},
  });
  coordinator.setTeleprompter({
    text: "Project-specific script",
    scrollSpeed: 42,
    opacity: 0.88,
    position: { x: 320, y: 40 },
    size: { width: 680, height: 300 },
  });
  await coordinator.flush();

  const persisted = memory.getCurrent();
  assert(persisted?.recordings.length === 1, "recording persisted");
  assert(
    persisted?.teleprompter.text === "Project-specific script" &&
      persisted.teleprompter.position.x === 320,
    "teleprompter persisted",
  );
  assert(persisted?.recordings[0].storage.kind === "opfs", "OPFS reference");
  assert(
    persisted?.sources.some((source) => source.assetId === "new-image-asset"),
    "new document persisted",
  );
  assert(
    !persisted?.sources.some((source) => source.assetId === "legacy-pdf-asset"),
    "retired document removed",
  );
  assert(
    persisted?.sources.some((source) => source.id === WHITEBOARD_SOURCE_ID),
    "whiteboard retained",
  );

  const restoredCoordinator = new CourseProjectCoordinator({
    repository: memory.repository,
    saveDelayMs: 0,
    now: () => ++now,
  });
  const restored = await restoredCoordinator.initialize();
  assert(restored.mode === "loaded", "refresh restore mode");
  assert(restored.project?.recordings[0].bytesWritten === 42_000, "recording restored");

  const futureError = new CourseProjectSchemaError(
    "UNSUPPORTED_NEWER_VERSION",
    "future schema",
    { foundVersion: 99, readOnly: true },
  );
  const futureMemory = createMemoryRepository({ loadError: futureError });
  const futureCoordinator = new CourseProjectCoordinator({
    repository: futureMemory.repository,
    saveDelayMs: 0,
  });
  const future = await futureCoordinator.initialize();
  futureCoordinator.touchWhiteboard();
  await futureCoordinator.flush();
  assert(future.readOnly && future.mode === "read-only", "future read-only guard");
  assert(futureMemory.getSaveCount() === 0, "future project was not overwritten");

  let retryErrorCount = 0;
  const retryMemory = createMemoryRepository({
    current: persisted,
    failNextSaves: 1,
  });
  const retryCoordinator = new CourseProjectCoordinator({
    repository: retryMemory.repository,
    saveDelayMs: 0,
    now: () => ++now,
    onError: () => {
      retryErrorCount += 1;
    },
  });
  await retryCoordinator.initialize();
  retryCoordinator.touchWhiteboard();
  await retryCoordinator.flush();
  assert(retryErrorCount === 1, "save failure was not reported");
  assert(retryMemory.getSaveCount() === 0, "failed save was counted as committed");
  await retryCoordinator.flush();
  assert(retryMemory.getSaveCount() === 1, "failed snapshot was not retried");

  return {
    initializedMode: initialized.mode,
    sourceCount: persisted?.sources.length ?? 0,
    recordingCount: persisted?.recordings.length ?? 0,
    recordingStorage: persisted?.recordings[0].storage.kind ?? null,
    teleprompterText: persisted?.teleprompter.text ?? null,
    restoredMode: restored.mode,
    futureReadOnly: future.readOnly,
    futureSaveCount: futureMemory.getSaveCount(),
    failedSaveRetried: retryMemory.getSaveCount() === 1,
  };
};
