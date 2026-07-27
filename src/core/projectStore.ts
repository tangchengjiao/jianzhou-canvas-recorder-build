import type {
  AppState,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AnnotationStroke } from "../content/annotations";
import type { DocumentPresentationSettings } from "../shared/presentation";
import {
  parseCourseProject,
  summarizeCourseProject,
  type CourseProject,
  type CourseProjectSummary,
} from "./courseProject";

const DATABASE_NAME = "excalidraw-recorder";
const DATABASE_VERSION = 3;
const PROJECT_STORE_NAME = "projects";
const ASSET_STORE_NAME = "assets";
const CONTENT_SESSION_STORE_NAME = "contentSessions";
const COURSE_PROJECT_STORE_NAME = "courseProjects";
const METADATA_STORE_NAME = "metadata";
const PROJECT_KEY = "current";
const DOCUMENT_SESSION_KEY = "current";
const CURRENT_PROJECT_ID_KEY = "currentProjectId";

export type ProjectSnapshot = {
  elements: readonly OrderedExcalidrawElement[];
  files: BinaryFiles;
  appState: Partial<AppState>;
  savedAt: number;
};

export type DocumentSession = {
  assetId: string;
  kind: "pdf" | "image" | "markdown" | "html";
  fileName: string;
  mimeType: string;
  /** The active page index. The first page is page 0. */
  currentPage: number;
  fitMode: "contain" | "cover";
  annotationsByPage: Record<string, AnnotationStroke[]>;
  presentation?: DocumentPresentationSettings;
  savedAt: number;
};

const createDatabaseError = (message: string, cause?: DOMException | null) => {
  if (cause) return cause;
  return new DOMException(message, "UnknownError");
};

const openDatabase = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    let settled = false;

    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PROJECT_STORE_NAME)) {
        database.createObjectStore(PROJECT_STORE_NAME);
      }
      if (!database.objectStoreNames.contains(ASSET_STORE_NAME)) {
        database.createObjectStore(ASSET_STORE_NAME);
      }
      if (!database.objectStoreNames.contains(CONTENT_SESSION_STORE_NAME)) {
        database.createObjectStore(CONTENT_SESSION_STORE_NAME);
      }
      // v3 adds a versioned multi-project layer without changing or deleting
      // any of the v1/v2 stores above. The inline id keeps list/load operations
      // independent from the legacy single-project key.
      if (!database.objectStoreNames.contains(COURSE_PROJECT_STORE_NAME)) {
        database.createObjectStore(COURSE_PROJECT_STORE_NAME, {
          keyPath: "id",
        });
      }
      if (!database.objectStoreNames.contains(METADATA_STORE_NAME)) {
        database.createObjectStore(METADATA_STORE_NAME);
      }
    });

    request.addEventListener("blocked", () => {
      if (settled) return;
      settled = true;
      reject(
        new DOMException(
          "The local project database upgrade is blocked by another open tab. Close the other tab and try again.",
          "InvalidStateError",
        ),
      );
    });

    request.addEventListener("success", () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }

      settled = true;
      // A newer app version may need to upgrade the same database. Closing the
      // connection here prevents this tab from indefinitely blocking it.
      database.addEventListener("versionchange", () => database.close());
      resolve(database);
    });

    request.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      reject(
        createDatabaseError(
          "Could not open the local project database.",
          request.error,
        ),
      );
    });
  });

const readStoreValue = async <T>(
  storeName: string,
  key: IDBValidKey,
): Promise<T | null> => {
  const database = await openDatabase();
  return new Promise<T | null>((resolve, reject) => {
    const transaction = database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).get(key);
    let value: T | null = null;
    let settled = false;

    const rejectOnce = (error?: DOMException | null) => {
      if (settled) return;
      settled = true;
      database.close();
      reject(createDatabaseError(`Could not read from ${storeName}.`, error));
    };

    request.addEventListener("success", () => {
      value = (request.result as T | undefined) ?? null;
    });
    request.addEventListener("error", () => rejectOnce(request.error));
    transaction.addEventListener("complete", () => {
      if (settled) return;
      settled = true;
      database.close();
      resolve(value);
    });
    transaction.addEventListener("error", () => rejectOnce(transaction.error));
    transaction.addEventListener("abort", () => rejectOnce(transaction.error));
  });
};

const writeStoreValue = async <T>(
  storeName: string,
  key: IDBValidKey,
  value: T,
) => {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    let settled = false;

    const rejectOnce = (error?: DOMException | null) => {
      if (settled) return;
      settled = true;
      database.close();
      reject(createDatabaseError(`Could not write to ${storeName}.`, error));
    };

    transaction.objectStore(storeName).put(value, key);
    transaction.addEventListener("complete", () => {
      if (settled) return;
      settled = true;
      database.close();
      resolve();
    });
    transaction.addEventListener("error", () => rejectOnce(transaction.error));
    transaction.addEventListener("abort", () => rejectOnce(transaction.error));
  });
};

const deleteStoreValue = async (storeName: string, key: IDBValidKey) => {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    let settled = false;

    const rejectOnce = (error?: DOMException | null) => {
      if (settled) return;
      settled = true;
      database.close();
      reject(createDatabaseError(`Could not delete from ${storeName}.`, error));
    };

    transaction.objectStore(storeName).delete(key);
    transaction.addEventListener("complete", () => {
      if (settled) return;
      settled = true;
      database.close();
      resolve();
    });
    transaction.addEventListener("error", () => rejectOnce(transaction.error));
    transaction.addEventListener("abort", () => rejectOnce(transaction.error));
  });
};

/** Loads the existing Excalidraw project stored by both database v1 and v2. */
export const loadProjectSnapshot = async (): Promise<ProjectSnapshot | null> =>
  readStoreValue<ProjectSnapshot>(PROJECT_STORE_NAME, PROJECT_KEY);

/** Preserves the original v1 API while writing through the upgraded database. */
export const saveProjectSnapshot = async (snapshot: ProjectSnapshot) =>
  writeStoreValue(PROJECT_STORE_NAME, PROJECT_KEY, snapshot);

export const loadDocumentSession = async (): Promise<DocumentSession | null> =>
  readStoreValue<DocumentSession>(
    CONTENT_SESSION_STORE_NAME,
    DOCUMENT_SESSION_KEY,
  );

export const saveDocumentSession = async (session: DocumentSession) =>
  writeStoreValue(CONTENT_SESSION_STORE_NAME, DOCUMENT_SESSION_KEY, session);

export const clearDocumentSession = async () =>
  deleteStoreValue(CONTENT_SESSION_STORE_NAME, DOCUMENT_SESSION_KEY);

export const loadDocumentAsset = async (
  assetId: string,
): Promise<Blob | null> => {
  if (!assetId.trim()) return null;
  const value = await readStoreValue<Blob>(ASSET_STORE_NAME, assetId);
  return value instanceof Blob ? value : null;
};

export const saveDocumentAsset = async (assetId: string, asset: Blob) => {
  if (!assetId.trim()) {
    throw new TypeError("A document asset id is required.");
  }
  if (!(asset instanceof Blob)) {
    throw new TypeError("A document asset must be stored as a Blob.");
  }
  await writeStoreValue(ASSET_STORE_NAME, assetId, asset);
};

export const deleteDocumentAsset = async (assetId: string) => {
  if (!assetId.trim()) return;
  await deleteStoreValue(ASSET_STORE_NAME, assetId);
};

const closeAfterTransaction = (
  database: IDBDatabase,
  transaction: IDBTransaction,
  operation: string,
) =>
  new Promise<void>((resolve, reject) => {
    let settled = false;
    const rejectOnce = (error?: DOMException | null) => {
      if (settled) return;
      settled = true;
      database.close();
      reject(createDatabaseError(operation, error));
    };
    transaction.addEventListener("complete", () => {
      if (settled) return;
      settled = true;
      database.close();
      resolve();
    });
    transaction.addEventListener("error", () => rejectOnce(transaction.error));
    transaction.addEventListener("abort", () => rejectOnce(transaction.error));
  });

/**
 * Commits a newly imported document, its active session and retirement of the
 * previous asset in one transaction. A crash can no longer leave the session
 * pointing at a blob that has already been deleted.
 */
export const replaceDocumentAssetAndSession = async (
  asset: Blob,
  session: DocumentSession,
  previousAssetId?: string | null,
): Promise<void> => {
  if (!(asset instanceof Blob)) {
    throw new TypeError("A document asset must be stored as a Blob.");
  }
  const assetId = session.assetId.trim();
  if (!assetId) throw new TypeError("A document asset id is required.");

  const database = await openDatabase();
  const transaction = database.transaction(
    [ASSET_STORE_NAME, CONTENT_SESSION_STORE_NAME],
    "readwrite",
  );
  const assetStore = transaction.objectStore(ASSET_STORE_NAME);
  assetStore.put(asset, assetId);
  transaction
    .objectStore(CONTENT_SESSION_STORE_NAME)
    .put(session, DOCUMENT_SESSION_KEY);
  const retiredId = previousAssetId?.trim();
  if (retiredId && retiredId !== assetId) assetStore.delete(retiredId);
  await closeAfterTransaction(
    database,
    transaction,
    "Could not atomically replace the imported document.",
  );
};

/** Clears the active document reference and its blob in the same transaction. */
export const clearDocumentSessionAndAsset = async (
  assetId?: string | null,
): Promise<void> => {
  const database = await openDatabase();
  const transaction = database.transaction(
    [ASSET_STORE_NAME, CONTENT_SESSION_STORE_NAME],
    "readwrite",
  );
  transaction
    .objectStore(CONTENT_SESSION_STORE_NAME)
    .delete(DOCUMENT_SESSION_KEY);
  const id = assetId?.trim();
  if (id) transaction.objectStore(ASSET_STORE_NAME).delete(id);
  await closeAfterTransaction(
    database,
    transaction,
    "Could not clear the active document atomically.",
  );
};

/** Returns all current manifests, newest first. Every value is runtime validated. */
export const listCourseProjectManifests = async (): Promise<CourseProject[]> => {
  const database = await openDatabase();
  return new Promise<CourseProject[]>((resolve, reject) => {
    const transaction = database.transaction(
      COURSE_PROJECT_STORE_NAME,
      "readonly",
    );
    const request = transaction
      .objectStore(COURSE_PROJECT_STORE_NAME)
      .getAll();
    let rawProjects: unknown[] = [];
    let settled = false;

    const rejectOnce = (error?: unknown) => {
      if (settled) return;
      settled = true;
      database.close();
      reject(
        error instanceof Error
          ? error
          : createDatabaseError("Could not list course projects."),
      );
    };

    request.addEventListener("success", () => {
      rawProjects = request.result as unknown[];
    });
    request.addEventListener("error", () => rejectOnce(request.error));
    transaction.addEventListener("complete", () => {
      if (settled) return;
      try {
        const projects = rawProjects
          .map((project) => parseCourseProject(project))
          .sort((left, right) => right.updatedAt - left.updatedAt);
        settled = true;
        database.close();
        resolve(projects);
      } catch (error) {
        rejectOnce(error);
      }
    });
    transaction.addEventListener("error", () => rejectOnce(transaction.error));
    transaction.addEventListener("abort", () => rejectOnce(transaction.error));
  });
};

/** Lightweight project-list API for a future project picker. */
export const listCourseProjects = async (): Promise<CourseProjectSummary[]> =>
  (await listCourseProjectManifests()).map(summarizeCourseProject);

export const loadCourseProjectManifest = async (
  projectId: string,
): Promise<CourseProject | null> => {
  const id = projectId.trim();
  if (!id) return null;
  const raw = await readStoreValue<unknown>(COURSE_PROJECT_STORE_NAME, id);
  return raw === null ? null : parseCourseProject(raw);
};

export const getCurrentCourseProjectId = async (): Promise<string | null> => {
  const value = await readStoreValue<unknown>(
    METADATA_STORE_NAME,
    CURRENT_PROJECT_ID_KEY,
  );
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("The current course project id metadata is invalid.");
  }
  return value;
};

/**
 * Loads the current pointer and its manifest from one readonly transaction so
 * a simultaneous project switch cannot produce a mismatched read.
 */
export const loadCurrentCourseProjectManifest = async (): Promise<CourseProject | null> => {
  const database = await openDatabase();
  return new Promise<CourseProject | null>((resolve, reject) => {
    const transaction = database.transaction(
      [METADATA_STORE_NAME, COURSE_PROJECT_STORE_NAME],
      "readonly",
    );
    const metadataRequest = transaction
      .objectStore(METADATA_STORE_NAME)
      .get(CURRENT_PROJECT_ID_KEY);
    let rawProject: unknown = null;
    let settled = false;

    const rejectOnce = (error?: unknown) => {
      if (settled) return;
      settled = true;
      database.close();
      reject(
        error instanceof Error
          ? error
          : createDatabaseError("Could not load the current course project."),
      );
    };

    metadataRequest.addEventListener("success", () => {
      const projectId = metadataRequest.result as unknown;
      if (projectId === undefined || projectId === null) return;
      if (typeof projectId !== "string" || !projectId.trim()) {
        transaction.abort();
        rejectOnce(
          new TypeError("The current course project id metadata is invalid."),
        );
        return;
      }
      const projectRequest = transaction
        .objectStore(COURSE_PROJECT_STORE_NAME)
        .get(projectId);
      projectRequest.addEventListener("success", () => {
        rawProject = projectRequest.result ?? null;
      });
      projectRequest.addEventListener("error", () =>
        rejectOnce(projectRequest.error),
      );
    });
    metadataRequest.addEventListener("error", () =>
      rejectOnce(metadataRequest.error),
    );
    transaction.addEventListener("complete", () => {
      if (settled) return;
      try {
        const project = rawProject === null ? null : parseCourseProject(rawProject);
        settled = true;
        database.close();
        resolve(project);
      } catch (error) {
        rejectOnce(error);
      }
    });
    transaction.addEventListener("error", () => rejectOnce(transaction.error));
    transaction.addEventListener("abort", () => {
      if (!settled) rejectOnce(transaction.error);
    });
  });
};

/** Saves a manifest without changing the current-project pointer. */
export const saveCourseProjectManifest = async (
  project: CourseProject,
): Promise<CourseProject> => {
  const manifest = parseCourseProject(project);
  const database = await openDatabase();
  const transaction = database.transaction(
    COURSE_PROJECT_STORE_NAME,
    "readwrite",
  );
  transaction.objectStore(COURSE_PROJECT_STORE_NAME).put(manifest);
  await closeAfterTransaction(
    database,
    transaction,
    "Could not save the course project.",
  );
  return manifest;
};

/**
 * Atomically writes the manifest and currentProjectId. A crash can therefore
 * never leave the pointer committed without its corresponding project.
 */
export const saveCurrentCourseProjectManifest = async (
  project: CourseProject,
): Promise<CourseProject> => {
  const manifest = parseCourseProject(project);
  const database = await openDatabase();
  const transaction = database.transaction(
    [COURSE_PROJECT_STORE_NAME, METADATA_STORE_NAME],
    "readwrite",
  );
  transaction.objectStore(COURSE_PROJECT_STORE_NAME).put(manifest);
  transaction
    .objectStore(METADATA_STORE_NAME)
    .put(manifest.id, CURRENT_PROJECT_ID_KEY);
  await closeAfterTransaction(
    database,
    transaction,
    "Could not save the current course project.",
  );
  return manifest;
};

/** Switches the current pointer only when the referenced manifest exists. */
export const setCurrentCourseProjectId = async (
  projectId: string | null,
): Promise<void> => {
  const id = projectId?.trim() ?? null;
  const database = await openDatabase();
  const transaction = database.transaction(
    [COURSE_PROJECT_STORE_NAME, METADATA_STORE_NAME],
    "readwrite",
  );
  const metadataStore = transaction.objectStore(METADATA_STORE_NAME);
  if (id === null) {
    metadataStore.delete(CURRENT_PROJECT_ID_KEY);
  } else {
    const projectRequest = transaction
      .objectStore(COURSE_PROJECT_STORE_NAME)
      .get(id);
    projectRequest.addEventListener("success", () => {
      if (projectRequest.result === undefined) {
        transaction.abort();
        return;
      }
      metadataStore.put(id, CURRENT_PROJECT_ID_KEY);
    });
  }
  try {
    await closeAfterTransaction(
      database,
      transaction,
      id === null
        ? "Could not clear the current course project."
        : `Could not select course project "${id}" because it does not exist.`,
    );
  } catch (error) {
    if (id !== null && error instanceof DOMException && error.name === "AbortError") {
      throw new DOMException(
        `Could not select course project "${id}" because it does not exist.`,
        "NotFoundError",
      );
    }
    throw error;
  }
};

// Concise aliases used by product code; the Manifest names above make the
// persistence boundary explicit for conversion/export code.
export const loadCourseProject = loadCourseProjectManifest;
export const loadCurrentCourseProject = loadCurrentCourseProjectManifest;
export const saveCourseProject = saveCourseProjectManifest;
export const saveCurrentCourseProject = saveCurrentCourseProjectManifest;
