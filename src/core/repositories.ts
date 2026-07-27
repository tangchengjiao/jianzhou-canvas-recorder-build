import type { CourseProject, CourseProjectSummary } from "./courseProject";
import {
  clearDocumentSession,
  clearDocumentSessionAndAsset,
  deleteDocumentAsset,
  getCurrentCourseProjectId,
  listCourseProjectManifests,
  listCourseProjects,
  loadCourseProject,
  loadCurrentCourseProject,
  loadDocumentAsset,
  loadDocumentSession,
  loadProjectSnapshot,
  replaceDocumentAssetAndSession,
  saveCourseProject,
  saveCurrentCourseProject,
  saveDocumentAsset,
  saveDocumentSession,
  saveProjectSnapshot,
  setCurrentCourseProjectId,
  type DocumentSession,
  type ProjectSnapshot,
} from "./projectStore";

/**
 * Versioned project metadata and the legacy v1/v2 compatibility records.
 *
 * Product code depends on this contract instead of IndexedDB directly. The
 * desktop implementation can therefore move the same calls to an atomic
 * project directory without leaking host paths into the renderer.
 */
export interface ProjectRepository {
  loadLegacySnapshot(): Promise<ProjectSnapshot | null>;
  saveLegacySnapshot(snapshot: ProjectSnapshot): Promise<void>;
  loadLegacyDocumentSession(): Promise<DocumentSession | null>;
  saveLegacyDocumentSession(session: DocumentSession): Promise<void>;
  clearLegacyDocumentSession(): Promise<void>;

  list(): Promise<CourseProjectSummary[]>;
  listManifests(): Promise<CourseProject[]>;
  load(projectId: string): Promise<CourseProject | null>;
  loadCurrent(): Promise<CourseProject | null>;
  getCurrentId(): Promise<string | null>;
  save(project: CourseProject): Promise<CourseProject>;
  saveCurrent(project: CourseProject): Promise<CourseProject>;
  selectCurrent(projectId: string | null): Promise<void>;
}

/**
 * Binary assets are intentionally independent from the JSON project manifest.
 * References remain opaque, while the atomic replacement operations prevent a
 * manifest/session from pointing at a blob that was already retired.
 */
export interface AssetRepository {
  load(assetId: string): Promise<Blob | null>;
  save(assetId: string, asset: Blob): Promise<void>;
  delete(assetId: string): Promise<void>;
  replaceActiveDocument(
    asset: Blob,
    session: DocumentSession,
    previousAssetId?: string | null,
  ): Promise<void>;
  clearActiveDocument(assetId?: string | null): Promise<void>;
}

/** Browser repository preserving every v1/v2 store while adding v3 manifests. */
export const indexedDbProjectRepository: ProjectRepository = {
  loadLegacySnapshot: loadProjectSnapshot,
  saveLegacySnapshot: saveProjectSnapshot,
  loadLegacyDocumentSession: loadDocumentSession,
  saveLegacyDocumentSession: saveDocumentSession,
  clearLegacyDocumentSession: clearDocumentSession,
  list: listCourseProjects,
  listManifests: listCourseProjectManifests,
  load: loadCourseProject,
  loadCurrent: loadCurrentCourseProject,
  getCurrentId: getCurrentCourseProjectId,
  save: saveCourseProject,
  saveCurrent: saveCurrentCourseProject,
  selectCurrent: setCurrentCourseProjectId,
};

/** Browser asset repository backed by the existing IndexedDB asset store. */
export const indexedDbAssetRepository: AssetRepository = {
  load: loadDocumentAsset,
  save: saveDocumentAsset,
  delete: deleteDocumentAsset,
  replaceActiveDocument: replaceDocumentAssetAndSession,
  clearActiveDocument: clearDocumentSessionAndAsset,
};

